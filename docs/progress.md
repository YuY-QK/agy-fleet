# agy-fleet 进度

本项目唯一的进度摘要。新会话读 `AGENTS.md` 和这份文件，就从这里接着做。保持精简：只写现状、计划和待办；规则写在各自的文档里。

## 现状

- **M0 验证完成**：七项结论见 [acp-验证结论.md](acp-验证结论.md)；方案 [PLAN_v1.1.md](PLAN_v1.1.md) 已确认。GitHub 仓库 `YuY-QK/agy-fleet`，npm 包名 `agy-fleet` 可用。
- **M1 单账号跑通：已完成**（已推送到 `YuY-QK/agy-fleet`，GitHub Actions CI 全部步骤通过）。
  - 骨架：TypeScript（Node `^22.13 || >=24`）、ESM、pnpm、tsdown、vitest、eslint + prettier、GitHub Actions CI（类型检查、lint、格式、测试、构建）。依赖锁定：`@agentclientprotocol/sdk` 2.0.2（满两周的最新版；2.1.0 起不足两周，2.0.2 与 `agy acp` 的 protocolVersion 1 实测兼容）、`@modelcontextprotocol/sdk` 1.32.2、`zod` 4.6.7。
  - 模块：`acp/{process,worker,collector}`、`git/worktree`、`policy/permissions`、`accounts/credStore`（仅 macOS 钥匙串解锁）、`tasks/run`、`mcp/server`（仅前台 `run_task`）、`log`、`config`（环境变量）。
  - 账号：`AGY_FLEET_ACCOUNT_HOME` 指向账号 HOME（开发测试时指向本机的测试账号）。

### 验证证据（2026-11-09）

- `pnpm typecheck`、`pnpm lint`、`pnpm test`（20 项）、`pnpm build` 通过；权限判定单测覆盖越界绝对路径、`..`、符号链接（目录/文件/悬空/指向内部）、`link/..` 真实语义、`.git`、命令、其他类别。
- 用 MCP SDK 客户端经 stdio 调用构建产物，账号 acct1：
  - 新建文件任务：`stop_reason=end_turn`，汇报完整，diff 为 `hello.txt +1/-0`，返回 worktree 路径与分支 `agy-fleet/<task_id>`，日志写入 `~/.agy-fleet/logs/`。
  - 命令任务（`echo hi > from_cmd.txt`）：命令被拒，`denied` 含 `execute / run_command / 命令原文`，`final_report` 为空（与实测结论一致），diff 为空。
- `claude mcp add` 注册本地构建产物成功，`claude mcp list` 显示 Connected。
- 真实客户端：Claude Code 桌面会话通过项目级 `.mcp.json` 加载本地构建产物，模型自行发现并调用 `run_task`（账号 acct1），`stop_reason=end_turn`，worktree 内 diff 正确（新增并导出 `sub`，`add` 不变），分支 `agy-fleet/<task_id>`，原仓库未改动。

### 独立重写（2026-11-09）

- 依据方案 §6、验证结论与 `spike/` 探针，从头重写 `acp/process.ts`、`acp/worker.ts`、`acp/collector.ts`、`log.ts`、`tasks/run.ts`；对外接口（`runTask`、`Collector`、`log.*`）与其余源文件、既有测试均未改动。
- 设计：子进程自成进程组，回收时 SIGTERM→宽限→整组 SIGKILL，组长退出即清扫孙进程，进程退出时同步兜底；ACP 用自带的按行 JSON-RPC 对端（只借用 SDK 类型）；握手 60s 超时，认证类错误归 `account_not_logged_in`；单轮超时/取消先发 `session/cancel` 再抛 `timeout`/`cancelled`。
- 新增测试：`acp/process.test.ts`（孙进程回收、忽略 SIGTERM 强杀、组长退出后清扫、命令不存在）、`acp/worker.test.ts`（用 `mock-agent.fixture.mjs` 模拟 agent：握手+权限应答、认证失败、握手超时、崩溃、单轮超时、取消）。
- 验证：`pnpm typecheck`、`lint`、`fmt:check`、`test`（30 项）、`build` 通过；MCP 客户端经 stdio 调新构建产物（acct1）：新建文件 `end_turn`、diff `hello.txt +1/-0`；执行命令被拒，`denied` 含 `execute / run_command / echo hi > from_cmd.txt`；无残留 agy 进程。

- **M2 多账号与续聊：已完成**（已推送到 `YuY-QK/agy-fleet`，提交 `6e86e55` 的 GitHub Actions CI 通过；端到端五项已全部完成）。
  - 新增：`accounts/{store,lease,models}`、`tasks/{store,manager}`、`errors.ts`（错误码全集、分类、暂停粒度）、`fsutil.ts`（文件锁/原子写/pid 检查）；`acp/worker` 增加 `session/load` 恢复与 `model`/`effort`（`session/set_config_option`）；`mcp/server` 提供 PLAN §7 全部 8 个工具；`tasks/run.ts` 由 `manager.ts` 取代。细化决定见 PLAN 变更记录 v1.2。
  - 默认值（待你确认，可用环境变量改）：每账号并发 1、全局并发 4、空闲超时 30 分钟、单轮超时 30 分钟、租约心跳 5s/过期 30s、`wait_task` 默认 45s/上限 300s。
  - 验证（2026-11-09）：`pnpm typecheck`、`lint`、`fmt:check`、`test`（97 项）、`build` 通过。新增测试覆盖：租约（同进程上限、全局上限、心跳过期、**6 个真实子进程同时抢占只有 1 个成功**、**SIGKILL 持有者后回收**、心跳续命）、账号库与暂停粒度、错误分类、状态机非法转移、后台 `wait_task` 超时/取消/关闭、空闲超时后 `session/load` 续聊、重启后查看与接手、跨进程只读、模拟额度/认证错误的暂停与恢复、MCP 工具端到端（内存传输）。
  - 真实账号 acct1 端到端（MCP 客户端 → `dist/cli.js`）：②后台派发 + `wait_task` + `send_message` 返工，`hello.txt` 由 `hello` 改为 `hello world`；③两个 `agy-fleet mcp` 进程争用同一账号，后者得到 `account_busy`，`list_accounts` 在另一进程里显示 busy 与任务号，跨进程 `send_message` 被拒（只读）；④`cancel_task` 后租约释放、无 agy 进程、worktree 保留，`close_task(delete_branch)` 删除 worktree 与分支；⑤SIGKILL 持有租约的 MCP 进程后，租约文件仍在但被下一个进程回收，同账号新任务成功，并用 `send_message` 接手被杀进程的任务（真实 `session/load`，之前的与新的修改都在 diff 里）；另验证空闲超时（0.05 分钟）后子进程退出，`send_message` 经 `session/load` 仍记得上一轮任务。全程无残留 agy 进程与租约。
  - ①两账号并行（真实账号 acct1 + acct2，缺省选号）：两个后台任务分别落在不同账号并行完成（约 19 秒），第三个任务得到 `account_busy`，`list_accounts` 显示两账号均 busy 及各自任务号，结束后无残留 agy 进程与租约。acct2 已按 §2.2 建独立空钥匙串并重新登录：令牌在 acct2 自己的钥匙串里（service=gemini），用户真实钥匙串的 list/default/login 前后无变化。acct2 目录里仍有登录前遗留的回退令牌文件（陈旧、未再写入），可由使用者自行删除。
  - 自查（租约/并发/僵尸进程）：检查并修复了“空闲期间子进程自己退出后 `send_message` 会卡到单轮超时”（现立即识别并在新进程 load 恢复，有测试）；租约“检查人数+创建文件”在同一把文件锁里；陈旧锁回收有极小的竞态窗口（见未验证）。

- **M3 账号命令与权限：已实现，待你验收**（本地提交，未推送）。细则见 PLAN v1.3（§6.4、§6.5、§6.7、§6.8）。
  - 新增：`config.ts`（`config.yaml`，环境变量 > 配置文件 > 默认值）、`policy/commands.ts`（命令白名单匹配）、`policy/permissions.ts`（受保护目录、任意 `.git` 段、可否询问）、`mcp/server.ts`（elicitation 询问）、`accounts/{credStore,setup}.ts`（钥匙串准备与比对、account 命令）、`doctor.ts`、`cli.ts`（`account …`、`doctor`）。任务结果新增 `approved`。去掉 `AGY_FLEET_RESUME`。依赖新增 `yaml` 2.9.1。
  - 验证（2026-11-10）：`pnpm typecheck`、`lint`、`fmt:check`、`test`（207 项，1 项非 macOS 用例在本机跳过）、`build` 通过。测试覆盖：组合命令绕过（`&&`、`;`、管道、子 shell、重定向、换行、`$()`、反引号、`VAR=` 前缀、zsh 的 `=cmd`/`^`）、按仓库白名单、deny/ask 两种策略（批准、拒绝、超时、客户端不支持、询问出错）、`.git`/受保护目录不询问、MCP 内存传输下的真实 elicitation 往返（含只声明 `elicitation: {}` 的旧客户端）、配置字段错误、account add/login/remove/resume、`--purge` 的确认与路径限制、doctor。钥匙串用例只在 macOS 用临时 HOME 跑，并断言本人钥匙串前后不变。
  - 手动：临时数据目录里 `account add t1 --no-login` 建出钥匙串并报告“前后无变化”，`doctor` 正确报告未登录，`remove --purge` 输错名称时什么都不删、输对后删除；本人钥匙串搜索列表与默认钥匙串前后一致，`~/Library/Preferences/com.apple.security.plist` 前后都不存在。`doctor --online` 对 acct1、acct2 通过。真实账号 acct1 经 MCP 客户端：白名单 `git status` 放行（日志记命中条目），`git status && echo hi > x.txt` 被拒并进 `denied`，无残留进程与租约。
  - 自审（钥匙串与权限）发现并已修复：①命令拆词原为黑名单，换成引号外字符白名单（覆盖 zsh 的 `^`、`=cmd` 等）；②源仓库或其他仓库的 `.git` 原本只算“越界、可询问”，改为任何 `.git` 段直接拒绝；③工作进程可请求修改 agy-fleet 的 `config.yaml`/账号库/账号 HOME（如 agy 自身设置）来给自己提权，改为受保护目录直接拒绝；④若将来 agy 的命令请求带工作目录字段，白名单命令可能在 worktree 外执行，改为该字段须在 worktree 内；⑤账号 HOME 与本人目录只比较字面路径，改为按真实路径比较且不能是本人目录的上级；⑥弹窗文本过长时截断。
  - **待你亲自验收**：①真实登录：`node dist/cli.js account add <名称> --email <邮箱>`，在浏览器完成授权（若弹“找不到钥匙串”点「取消」），之后 `account list` 显示 idle、`doctor` 显示凭据存在，再用它派一个任务；②`ask` 弹窗：在 `config.yaml` 设 `permissions.outside_policy: ask`，在 Claude Code 里派一个会执行非白名单命令的任务，确认出现弹窗，分别试“允许这一次”和“拒绝”，结果分别出现在 `approved`/`denied`。

### 未验证 / 已知限制

- 额度用尽无法真实触发：分类靠 `RESOURCE_EXHAUSTED`/429 文本匹配，只用模拟 agent 测过；真实文本待校正（原始错误已完整写入任务日志）。
- 文件锁的陈旧回收有极小竞态窗口（两个进程同时判定同一把陈旧锁）；租约临界区只有几次小文件读写，且以进程存活为主要判据，风险接受。
- SIGKILL 主进程后，空闲的 agy 子进程依赖 agy 自己在 stdin 关闭后退出（一次实测有约数秒的残留，随后消失）；正常退出与信号退出由 `shutdown` 回收。
- `isolation: none`（只读任务）未实现；`usage` 仍为空；Codex 等其他客户端未测；`tasks` 记录与日志的 14 天清理未做（M3/M4）。
- `ask` 弹窗只用 MCP SDK 内存传输测过；真实客户端（Claude Code 等）是否支持 elicitation、界面如何显示，待你验收。客户端不支持时按拒绝处理。
- 命令白名单的风险：会执行仓库代码的命令（测试、构建等）等于允许任意代码执行；末尾 `*` 条目允许任意参数。已写进 README 与 PLAN §6.5，需由使用者自行取舍。
- `account login` 对手动登记的外部 HOME 也会准备钥匙串（与 `add` 相同流程，同样前后比对）。

## 计划

- ~~M2 多账号与续聊~~（已完成）。
- M3 账号命令与权限：已实现，待验收（真实登录与 `ask` 弹窗由你操作），确认后推送。
- M4 发布：编排 prompt 与 skill、README（英/中）、npm 发布。
详见 [PLAN_v1.1.md](PLAN_v1.1.md) §9。

## 待办

- 已定：工作进程默认模型沿用 agy 默认（不指定）；`model`/`effort` 可按任务指定（M2 已接入）。
- 已定：产品不内置任何账号；开发测试临时用开发者本机账号，不进仓库。
