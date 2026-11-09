# agy-fleet 方案 v1.1（通用版，精简规划）

> 状态：**草案，待确认**。验证依据见 [acp-验证结论.md](acp-验证结论.md)。
> 标注：【已验证】实测过；【已定】已确认；【建议】待确认；【待验证】M0 实测。

## 0. 变更记录

| 版本 | 日期       | 变更                                                                                                                              |
| ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-11-09 | 自用版草案                                                                                                                        |
| v1.1 | 2026-11-09 | 改为通用、可公开安装的 MCP 服务器：任意 MCP 客户端可用；npm 分发；后台任务 + 查询；跨进程账号租约；随包附带编排指南；去掉个人信息 |

## 1. 一句话

一个开源 MCP 服务器：让任何支持 MCP 的 AI（Claude Code、Codex、Cursor 等）把编码任务分派给本机多个 Google 账号下的 Antigravity CLI，通过 ACP 驱动，各自在隔离的 git worktree 里并行执行，权限按规则逐项审批，结果交回调用方审查和返工。

## 2. 目标用户与场景

**用户**：已经在用某个 MCP 客户端写代码、装了 Antigravity CLI（`agy`），并且有一个或多个 Google 账号的开发者。

1. **并行实现**：主 AI 把需求拆成互不重叠的子任务，同时派给多个账号，逐个审查 diff 后合并。
2. **审查返工**：结果不合格时，在同一会话追加修改意见，工作进程带着上下文继续改。
3. **只读调研**：让工作进程读代码、写报告，不改文件。
4. **账号管理**：一条命令添加账号、登录、查看状态；换电脑后重新登录即可。

## 3. 价值与差异

- **多账号并行**：每个账号是一个独立工作进程，可同时运行，不是额度用完才切换。
- **按规则逐项审批权限**：基于 ACP 的权限请求逐条判断（只允许本任务 worktree 内编辑、命令白名单），不在规则内的可交给用户在客户端里确认，而不是全部放行。
- **隔离与可审查**：每个写任务一个 worktree 和分支，工作进程不 commit、不 push，提交合并由调用方决定。
- **客户端无关**：标准 MCP + 随包附带的编排指南，任何客户端都能用好。

## 4. 范围

**第一版包含**

- MCP 工具（§7）：账号、任务的派发/续聊/等待/列表/取消/关闭、模型列表。
- 命令行：`agy-fleet mcp`（MCP 服务器入口）、`account add|list|login|remove`、`doctor`（环境自检）。
- 账号隔离：每账号独立 HOME【已验证】。
- 凭据存储按平台处理：macOS 为每账号建独立空钥匙串以消除弹窗【待验证安全性】；Linux 跳过【建议】。
- 权限规则：worktree 内编辑放行、命令白名单、其余拒绝或交给用户确认（§6.5）【已定方向】。
- 账号出错/额度用尽：标记暂停并报告，不自动改派【已定】。
- 每任务一份可读日志；`list_tasks` 查看进度【已定】。
- 分发：npm 包，`npx` 一行接入；README 英文 + 中文，含 Claude Code、Codex、Cursor 及通用 JSON 配置写法。
- 编排指南：作为 MCP prompt 随服务器提供；另附可选的 Claude Code skill 文件。
- 开源：MIT 协议、语义化版本、CHANGELOG、CI（类型检查、lint、单元测试）。

**不做**

- 网页看板、常驻后台守护进程（第二版候选）。
- 自动改派、自动重试、规避额度或风控的任何处理。
- 工作进程 commit / push / 合并。
- 非 git 目录的写任务（只读任务可不建 worktree）。
- Windows（README 写明不支持）、远程机器、云端运行。
- 迁移账号凭据；调用 agy 以外的 agent。

## 5. 核心流程

```
调用方 AI ──run_task(prompt, repo, account?, background)──▶ agy-fleet
  选账号（显式指定，或取空闲账号）→ 取得账号租约
  建 worktree（分支 agy-fleet/<task_id>）→ 以该账号 HOME 启动 agy acp → session/new → session/prompt
  执行中：权限请求按规则审批；事件写日志
  ├─ 前台：本轮结束即返回结果
  └─ 后台：立即返回 task_id；稍后 wait_task 取结果
调用方审查 worktree 的 diff、跑测试
  ├─ 合格 → 调用方自行提交/合并分支 → close_task 清理
  └─ 不合格 → send_message(task_id, 修改意见) → 回到执行
```

任务状态：`running → idle(等待审查) → running …→ closed`；失败为 `failed`（带错误码）。

## 6. 技术方案

### 6.1 选型【建议】

- TypeScript，Node `^22.13 || >=24`，ESM，pnpm。
- 依赖：`@modelcontextprotocol/sdk`、`@agentclientprotocol/sdk`（版本 M0 锁定）、`zod`、`yaml`。
- 构建 tsdown，测试 vitest，规范 eslint + prettier，发布用 changesets。

### 6.2 模块

```
src/
  cli.ts                 命令入口：mcp / account / doctor
  mcp/server.ts          MCP 工具与 prompt 注册
  acp/process.ts         启动/关闭 agy acp 子进程（注入账号 HOME）
  acp/worker.ts          一个 ACP 会话：握手、新建/恢复会话、发送一轮、取消
  acp/collector.ts       汇总 session/update 事件：最终消息、工具调用、文件改动、用量
  tasks/registry.ts      任务表、状态机、持久化记录
  tasks/background.ts    后台轮次与等待
  accounts/store.ts      账号元数据（名称、邮箱、HOME、状态）
  accounts/lease.ts      跨进程账号租约（文件锁 + 心跳 + 过期回收）
  accounts/credStore.ts  按平台准备凭据存储
  git/worktree.ts        建/删 worktree、diff 统计
  policy/permissions.ts  权限判定（纯函数）
  policy/errors.ts       错误分类 → 错误码、账号是否暂停
  config.ts              配置加载与校验
  log.ts                 服务器日志与任务日志
skills/agy-fleet/SKILL.md  可选的 Claude Code 编排指南
```

### 6.3 进程模型与多客户端

- 每个 MCP 客户端会话启动一个 `agy-fleet mcp` 进程（stdio）。多个客户端同时运行时，通过 **`~/.agy-fleet/leases/` 下的账号租约文件**协调：同一账号同一时刻只被一个任务占用（并发上限可配置），进程退出或心跳超时后租约自动回收。用租约而不用常驻守护进程，是为了保持“装上即用”，常驻进程放第二版。
- 每个任务一个 `agy acp` 子进程，`HOME=<账号HOME>`，`cwd=<worktree>`。一轮结束后保留子进程等待续聊，空闲超时（默认 30 分钟）后关闭；之后的 `send_message` 用 `session/load` 恢复【待验证】。
- 已知限制：MCP 服务器随客户端会话结束而退出，进行中的任务随之终止；任务记录与结果持久化在 `~/.agy-fleet/tasks/`，之后仍可查看。
- 长任务与客户端超时：工具默认支持 `background: true`，立即返回，再用 `wait_task` 取结果（单次等待有上限，超时返回“仍在运行”而不是报错）。

### 6.4 账号与凭据

- 目录：`~/.agy-fleet/accounts/<名称>/` 作为该账号的 HOME（位置可配置）。
- `account add <名称>`：建 HOME → `credStore` 按平台准备 → 链接 `~/.gitconfig`（不链接 `~/.ssh`）→ 前台运行 `agy acp --login` 让用户在浏览器授权 → 读出邮箱写入元数据。
- macOS 空钥匙串：在账号 HOME 内建空钥匙串并设为该 HOME 的默认钥匙串。**前提是证明不改动用户真实的登录钥匙串与搜索列表**；证明不了则退回“登录时弹一次窗，点取消”，并在文档中说明。
- 元数据 `~/.agy-fleet/accounts.json`（名称、邮箱、状态、暂停原因）；凭据只在各账号 HOME 内，不记录到日志、不导出。
- `doctor`：检查 agy 是否安装与版本、各账号登录状态、git 可用性、平台支持情况。

### 6.5 权限

处理 `session/request_permission`，规则只来自配置文件，**不接受工具参数放宽**（防止调用方 AI 自己给自己提权）：

1. 文件编辑：所有路径（解析符号链接、`..` 之后）都在本任务 worktree 内 → 允许；否则按 `outside_policy` 处理。
2. 执行命令：匹配白名单（全局 + 按仓库覆盖）→ 允许；否则按 `outside_policy` 处理。
3. 其他类别（联网、浏览器、MCP 等）→ 按 `outside_policy` 处理。

- `outside_policy`：`deny`（默认）| `ask`（通过 MCP elicitation 让用户在客户端弹窗确认，客户端不支持时退为 `deny`）。
- 只回答“允许一次”，不回答“总是允许”，避免改写 agy 自身配置。
- 每次拒绝记入任务结果的 `denied` 列表。
- 权限请求所带字段（路径、命令原文）以 M0 实测为准；信息不足以判断的类别一律走 `outside_policy`。
- 会话模式用 agy 的默认（逐项询问）模式，不使用 `--dangerously-skip-permissions`。

### 6.6 给工作进程的固定指令

通过 ACP 会话的系统提示追加：只在当前目录工作；不 commit、不 push；结束时按固定格式汇报（做了什么、改了哪些文件、如何验证、遗留问题）。

### 6.7 错误与账号状态

- 错误码（明确枚举）：`agy_not_found`、`account_not_logged_in`、`account_busy`、`account_paused`、`quota_exhausted`、`auth_expired`、`timeout`、`agent_crashed`、`worktree_failed`、`invalid_input`、`cancelled`。
- `quota_exhausted` → 暂停该**账号 + 模型**组合（额度可能按模型分别计算，见验证结论 §2.3）；`auth_expired` → 暂停整个账号。都带原因和时间，`account login` 或 `account resume` 解除。
- 原始错误文本完整写入任务日志，以便校正分类规则。
- 令牌约 1 小时过期，依赖 agy 自动刷新【待验证】。

### 6.8 配置

`~/.agy-fleet/config.yaml`（全部可选）：账号目录、worktree 根目录（默认 `~/.agy-fleet/worktrees/`）、每账号并发、全局并发、空闲超时、单轮超时、默认模型与推理强度、命令白名单（全局/按仓库）、`outside_policy`。

### 6.9 隐私

- agy-fleet 自身不发网络请求、不收集遥测；提示词与文件由 agy 发送给 Google，使用对应账号。
- 任务日志 `~/.agy-fleet/logs/<task_id>.log`：时间、工具调用、权限决定、消息；不记录令牌与环境变量。记录保留 14 天，启动时清理。

## 7. MCP 接口

| 工具            | 入参                                                                                                                                    | 返回                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `list_accounts` | —                                                                                                                                       | 名称、邮箱、状态（idle/busy/paused+原因）、当前任务                                                                      |
| `list_models`   | `account?`                                                                                                                              | 可用模型与推理强度                                                                                                       |
| `run_task`      | `prompt`、`repo`、`description`、`account?`、`isolation?`（`worktree` 默认 / `none` 只读）、`base?`、`model?`、`effort?`、`background?` | 前台：`task_id`、账号、worktree、分支、结束原因、最终汇报、diff 统计、`denied`、日志路径；后台：`task_id` 与上述位置信息 |
| `send_message`  | `task_id`、`message`、`background?`                                                                                                     | 同 `run_task`                                                                                                            |
| `wait_task`     | `task_id`、`timeout_s?`                                                                                                                 | 结果，或“仍在运行”                                                                                                       |
| `list_tasks`    | `status?`                                                                                                                               | 任务列表：状态、账号、已运行时长、最近动作                                                                               |
| `cancel_task`   | `task_id`                                                                                                                               | 已取消                                                                                                                   |
| `close_task`    | `task_id`、`delete_branch?`                                                                                                             | 关闭会话并删除 worktree                                                                                                  |

**Prompt**：`orchestrate` —— 编排指南：如何拆分不重叠任务、写自包含的任务说明、何时用后台、如何审查 diff、如何写返工意见、何时自己动手。

失败统一为 MCP 工具错误：`code`（§6.7）、`message`、可选 `task_id` 与部分输出。

## 8. 安装体验（README 目标）

```bash
# 1. 前提：已安装 agy
# 2. 添加账号（每个账号一次）
npx -y agy-fleet account add work1
# 3. 接入客户端（示例：Claude Code）
claude mcp add agy-fleet -- npx -y agy-fleet mcp
```

Codex（`~/.codex/config.toml`）、Cursor 和通用 JSON 写法同样写入 README。包名可用性在 M0 确认。

## 9. 开发计划

| 阶段                  | 内容                                                                                                                       | 完成标准                                                                             | 建议模型                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| **M0 验证**           | ① SDK 版本；② 权限请求字段；③ `session/load` 续聊；④ 空钥匙串安全性；⑤ 令牌自动刷新；⑥ 额度用尽时 agy 返回什么；⑦ npm 包名 | 七项结论写入验证结论文档；④ 不安全则降级                                             | Opus                        |
| **M1 单账号跑通**     | 项目骨架与 CI、process/worker/collector、worktree、`run_task`（前台）、日志                                                | 在 Claude Code 里派一个小改动，拿到汇报与 diff                                       | Sonnet                      |
| **M2 多账号与续聊**   | 账号库与租约、后台/等待、`send_message`、`list_*`、`cancel/close`、错误分类与暂停                                          | 两账号并行完成两任务；一次返工成功；两个客户端同时使用不抢账号；模拟额度错误正确暂停 | Sonnet；租约逻辑审查用 Opus |
| **M3 账号命令与权限** | `account`/`doctor` 命令、平台凭据处理、权限规则 + elicitation、单元测试                                                    | 一条命令加好账号；越界编辑与非白名单命令被拒或弹窗确认，均有记录                     | Sonnet；权限审查用 Opus     |
| **M4 发布**           | 编排 prompt 与 skill、README（英/中）、在 Claude Code 与 Codex 实测、npm 发布                                              | 另一台 Mac 按 README 从零装好并完成一次派发                                          | Sonnet                      |

测试重点：权限判定（越界路径、符号链接、`..`、命令白名单）、租约（并发抢占、进程崩溃回收）、状态机、错误分类。ACP 交互用模拟 agent 做回放测试，不依赖真实账号。

## 10. 风险

| 风险                               | 应对                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| agy 更新改变 ACP 行为或凭据存储    | 文档记录已验证的 agy 版本；`doctor` 检查并提示                        |
| 多账号使用可能违反 Google 服务条款 | README 显著提示；工具不做任何规避额度或风控的处理；声明与 Google 无关 |
| 权限请求信息不足，无法精确判断路径 | 该类别走 `outside_policy`；必要时启用 agy `--sandbox`                 |
| 客户端会话结束导致任务中断         | 第一版接受并写明；结果持久化；第二版考虑常驻进程                      |
| 并行任务改出冲突代码               | 编排指南要求拆分时文件不重叠；冲突由调用方合并时处理                  |

## 11. 待定问题

1. ~~工作进程默认模型~~ 已定：不指定，沿用 agy 自身的默认模型；`run_task` 可按任务传 `model` 覆盖。
2. ~~GitHub 仓库地址与 npm 包名~~ 已定：`github.com/YuY-QK/agy-fleet`，npm 包名 `agy-fleet`（未被占用）。
3. ~~账号池放哪些账号~~ 已定：产品不内置任何账号，账号完全由使用者自行添加；开发测试时可在本机配置里临时使用开发者自己的账号，不写入仓库。
