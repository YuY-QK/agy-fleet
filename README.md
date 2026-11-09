# agy-fleet

MCP 服务器：把编码任务分派给本机 Antigravity CLI（`agy`），通过 ACP 驱动，在隔离的 git worktree 里执行，权限逐项审批。

> 当前为 M1（单账号、前台 `run_task`），尚未发布到 npm。方案见 [docs/PLAN_v1.1.md](docs/PLAN_v1.1.md)，进度见 [docs/progress.md](docs/progress.md)。

## 本地试用（M1）

前提：已安装 `agy`，并有一个已登录的账号目录（独立 HOME）。

```bash
pnpm install && pnpm build
claude mcp add agy-fleet -e AGY_FLEET_ACCOUNT_HOME=<账号HOME> -- node "$PWD/dist/cli.js" mcp
```

环境变量（均可选，除第一个外）：

| 变量                             | 含义                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `AGY_FLEET_ACCOUNT_HOME`         | 必填。账号的独立 HOME 目录                             |
| `AGY_FLEET_DATA_DIR`             | 数据目录，默认 `~/.agy-fleet`（worktree 与日志在其下） |
| `AGY_FLEET_WORKTREE_ROOT`        | worktree 根目录，默认 `<数据目录>/worktrees`           |
| `AGY_FLEET_AGY_BIN`              | agy 可执行文件，默认 `agy`                             |
| `AGY_FLEET_TURN_TIMEOUT_MINUTES` | 单轮超时，默认 30                                      |

工具 `run_task`：在新 worktree（分支 `agy-fleet/<task_id>`）里执行任务，返回汇报、diff 统计、被拒绝的操作和日志路径。M1 只允许 worktree 内的文件编辑，命令及其他操作一律拒绝并记入 `denied`。

## 开发

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## 许可

MIT，见 [LICENSE](LICENSE)。
