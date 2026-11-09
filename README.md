# agy-fleet

MCP 服务器：把编码任务分派给本机 Antigravity CLI（`agy`），通过 ACP 驱动，在隔离的 git worktree 里执行，权限逐项审批。

> 当前为 M2（多账号、后台任务、续聊），尚未发布到 npm。方案见 [docs/PLAN_v1.1.md](docs/PLAN_v1.1.md)，进度见 [docs/progress.md](docs/progress.md)。

## 本地试用（M2）

前提：已安装 `agy`；每个账号有独立 HOME 目录且已登录（账号管理命令在 M3，现在手动准备）。把账号登记到账号库 `~/.agy-fleet/accounts.json`：

```json
{
    "accounts": [
        { "name": "work1", "home": "<账号HOME>" },
        { "name": "work2", "home": "<另一个账号HOME>" }
    ]
}
```

```bash
pnpm install && pnpm build
claude mcp add agy-fleet -- node "$PWD/dist/cli.js" mcp
```

开发测试时也可用 `AGY_FLEET_ACCOUNT_HOME=<账号HOME>` 临时登记一个账号（名称取目录名）。

环境变量（均可选）：

| 变量                                | 含义                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `AGY_FLEET_DATA_DIR`                | 数据目录，默认 `~/.agy-fleet`（账号库、租约、任务记录、日志、worktree）    |
| `AGY_FLEET_ACCOUNTS_FILE`           | 账号库文件，默认 `<数据目录>/accounts.json`                                |
| `AGY_FLEET_ACCOUNT_HOME`            | 额外登记一个账号 HOME（开发测试用）                                        |
| `AGY_FLEET_WORKTREE_ROOT`           | worktree 根目录，默认 `<数据目录>/worktrees`                               |
| `AGY_FLEET_AGY_BIN`                 | agy 可执行文件，默认 `agy`                                                 |
| `AGY_FLEET_TURN_TIMEOUT_MINUTES`    | 单轮超时，默认 30                                                          |
| `AGY_FLEET_IDLE_TIMEOUT_MINUTES`    | 一轮结束后保留子进程等待续聊的时间，默认 30；超时后续聊自动 `session/load` |
| `AGY_FLEET_PER_ACCOUNT_CONCURRENCY` | 每账号同时运行的任务数，默认 1（账号库条目的 `maxConcurrency` 可覆盖）     |
| `AGY_FLEET_GLOBAL_CONCURRENCY`      | 所有账号合计的并发上限，默认 4                                             |
| `AGY_FLEET_RESUME`                  | 启动时解除暂停的账号名（逗号分隔，`*` 为全部）；`account resume` 命令在 M3 |

工具：`run_task`（可 `background`）、`wait_task`、`send_message`（返工）、`list_tasks`、`cancel_task`、`close_task`、`list_accounts`、`list_models`。每个任务一个 worktree 与分支 `agy-fleet/<task_id>`；工作进程不 commit/push，只允许 worktree 内的文件编辑，命令及其他操作一律拒绝并记入 `denied`。账号额度用尽或登录失效时，该“账号+模型”或整个账号会被暂停（`list_accounts` 可见原因），不会自动改派。

## 开发

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## 许可

MIT，见 [LICENSE](LICENSE)。
