# agy-fleet 进度

本项目唯一的进度摘要。新会话读 `AGENTS.md` 和这份文件，就从这里接着做。保持精简：只写现状、计划和待办；规则写在各自的文档里。

## 现状

- **M0 验证完成**：七项结论见 [acp-验证结论.md](acp-验证结论.md)；方案 [PLAN_v1.1.md](PLAN_v1.1.md) 已确认。GitHub 仓库 `YuY-QK/agy-fleet`，npm 包名 `agy-fleet` 可用。
- **M1 单账号跑通：已实现，等待确认**。
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

### 未验证

- Codex 等其他客户端未测（由开发者自行测试）。
- `tasks/run.ts` 的完整流程仅靠真实账号验收（`worker` 握手/权限/超时/取消已有模拟 agent 测试）。
- 未测：超时与客户端取消路径、agy 未登录/不存在时的错误码、钥匙串锁定时的解锁。
- `usage` 目前为空：agy 未发 `usage_update`，是否有用量字段待查。
- 未推送；`.github/workflows/ci.yml` 尚未在 GitHub 上跑过。

## 计划

- M2 多账号与续聊：账号库与租约、后台/等待、`send_message`、`list_*`、`cancel/close`、错误分类与暂停。
- M3 账号命令与权限：`account`/`doctor`、平台凭据处理、权限规则 + elicitation。
- M4 发布：编排 prompt 与 skill、README（英/中）、npm 发布。
详见 [PLAN_v1.1.md](PLAN_v1.1.md) §9。

## 待办

- 已定：工作进程默认模型沿用 agy 默认（不指定）；按任务指定 `model` 留到 M2 接入。
- 已定：产品不内置任何账号；开发测试临时用开发者本机账号，不进仓库。
