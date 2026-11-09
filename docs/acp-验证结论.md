# agy ACP 与多账号验证结论

验证环境：macOS（Apple Silicon），agy 1.5.3（ACP Server 1.5.3，protocolVersion 1），2026-11-09。
方案见 [PLAN_v1.1.md](PLAN_v1.1.md)。探针脚本在 `spike/`。

## 1. 可行性验证（第一轮）

| 验证项                                                | 结果                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP 链路（initialize → session/new → session/prompt） | 通过，单轮约 5–12s                                                                                                                                      |
| `--gemini-dir` 隔离账号                               | **不行**：凭据从 macOS 钥匙串固定条目（service=`gemini`，account=`antigravity`）读取，与数据目录无关                                                    |
| 独立 HOME 隔离账号                                    | 通过：钥匙串查找跟随 `HOME`，独立 HOME 下读不到用户主钥匙串里的凭据                                                                                     |
| 独立 HOME 下登录                                      | 通过：`HOME=<账号目录> agy acp --login`；无钥匙串时写入超时 5s 后回退为文件 `.gemini/antigravity-cli/antigravity-oauth-token`，并弹出“找不到钥匙串”窗口 |
| 两账号并发                                            | 通过：两个账号同时运行，各约 8s，身份不串                                                                                                               |

## 2. M0 验证

| #   | 项目                | 结论                                                                                                                                    |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | SDK 版本            | `@agentclientprotocol/sdk` 最新 2.5.0（2026-11-09），`@modelcontextprotocol/sdk` 最新 1.32.2（2026-10-23）。M1 选发布满两周的版本并锁定 |
| ②   | 权限请求字段        | 见 §2.1。足以按路径和命令原文判定                                                                                                       |
| ③   | `session/load` 续聊 | 通过：进程退出后，新进程 `session/load` 同一 sessionId，能答出上一进程中给的信息                                                        |
| ④   | 独立空钥匙串安全性  | 通过（见 §2.2）：用户真实钥匙串搜索列表、默认钥匙串、登录钥匙串均无变化；条目读写互相隔离                                               |
| ⑤   | 令牌自动刷新        | 通过：过期后的下一次运行自动刷新（新有效期 1 小时），任务正常完成                                                                       |
| ⑥   | 额度用尽的报错      | 未能实际触发，只做了静态分析（见 §2.3）。按模式匹配分类，并记录原始错误，等真实发生时校正                                               |
| ⑦   | npm 包名            | `agy-fleet` 未被占用                                                                                                                    |

### 2.1 权限请求（`session/request_permission`）

- 选项固定为 `{optionId:"allow", kind:"allow_once"}`、`{optionId:"deny", kind:"reject_once"}`，没有“总是允许”。
- 文件编辑：`toolCall.kind = "edit"`，`name = "write_file"`，`locations[].path` 为绝对路径，`rawInput.Path` 同上，`content[]` 带 diff。
- 执行命令：`toolCall.kind = "execute"`，`name = "run_command"`，命令原文在 `rawInput.CommandLine`（可能是 `a && b` 这样的组合命令），请求里没有工作目录字段。
- 被拒绝后 agy 往往直接结束本轮、不输出文字（`stopReason = end_turn`，回复为空）。因此“被拒绝的操作”必须由我们自己汇报给调用方。
- 读文件没有触发权限请求，所以读操作无法用权限规则限制。

### 2.2 独立空钥匙串

做法（在账号 HOME 下执行，`KC=<账号HOME>/Library/Keychains/agy.keychain-db`）：

```
mkdir -p <账号HOME>/Library/Keychains <账号HOME>/Library/Preferences   # Preferences 必须先建
HOME=<账号HOME> security create-keychain -p "" "$KC"
HOME=<账号HOME> security list-keychains -d user -s "$KC"
HOME=<账号HOME> security default-keychain -d user -s "$KC"
HOME=<账号HOME> security set-keychain-settings "$KC"     # 不自动上锁
```

- 设置写入的是 `<账号HOME>/Library/Preferences/com.apple.security.plist`，不是用户自己的偏好文件。
- 系统重启后钥匙串会处于锁定状态：启动 agy 前执行 `HOME=<账号HOME> security unlock-keychain -p "" "$KC"`，已验证可用。
- **坑**：若 `<账号HOME>/Library/Preferences` 不存在，默认钥匙串设置只在 cfprefsd 里短暂缓存、不落盘，之后 agy 写入时找不到默认钥匙串，仍会弹窗（实测 `exit status 154`）。建好目录后设置写入 plist，路径以 `~/Library/...` 形式保存、随 HOME 解析。
- 写入后应检查：`<账号HOME>/Library/Preferences/com.apple.security.plist` 存在，且新进程 `HOME=<账号HOME> security default-keychain -d user` 指向该钥匙串。
- agy 实际写入：通过。修正后重新登录，令牌直接存入账号自己的钥匙串，无回退、无弹窗；用户主钥匙串中的条目未被修改。

### 2.3 额度相关（静态分析）

agy 内部文本显示：额度用尽表现为 `RESOURCE_EXHAUSTED` / HTTP 429；额度可能**按模型分别计算**（有“额度用尽就换模型”的提示）。因此暂停的粒度应为“账号 + 模型”。`agy models` 不显示剩余额度。

## 3. 其他注意事项

- 登录时若弹出“找不到用于储存 antigravity 的钥匙串”，点「取消」，**不要点「还原为默认」**（会重建用户的登录钥匙串）。
- 独立 HOME 下 `git` 读不到用户配置，需要把 `~/.gitconfig` 链接进账号 HOME；`~/.ssh` 不链接。
- `--dangerously-skip-permissions` 会让工作进程不经审批执行任意操作，不采用。
