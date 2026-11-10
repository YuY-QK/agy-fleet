# agy-fleet

MCP 服务器：把编码任务分派给本机 Antigravity CLI（`agy`），通过 ACP 驱动，在隔离的 git worktree 里执行，权限逐项审批。

> 当前为 M3（账号命令、权限规则），尚未发布到 npm。方案见 [docs/PLAN_v1.1.md](docs/PLAN_v1.1.md)，进度见 [docs/progress.md](docs/progress.md)。

## 本地试用

前提：已安装 `agy`（Antigravity CLI）、git，macOS 或 Linux。

```bash
pnpm install && pnpm build
node dist/cli.js doctor                       # 环境自检
node dist/cli.js account add work1 --email <邮箱>   # 每个账号一次，浏览器里登录
claude mcp add agy-fleet -- node "$PWD/dist/cli.js" mcp
```

### 账号命令

| 命令                                                 | 作用                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account add <名称> [--email <邮箱>] [--no-login]`   | 新建账号 HOME（`<数据目录>/accounts/<名称>/`）；macOS 上建该账号独立的空钥匙串，并比对你本人的钥匙串前后无变化（有变化立即中止、不做修复）；链接 `~/.gitconfig`（不链接 `~/.ssh`）；登记后前台运行 `agy acp --login`。邮箱只作显示，不自动读取 |
| `account login <名称>`                               | （重新）登录；成功后解除整个账号的暂停，按模型的额度暂停保留                                                                                                                                                                                   |
| `account list [--json]`                              | 账号、状态（idle/busy/paused）、暂停原因、正在运行的任务                                                                                                                                                                                       |
| `account resume <名称>\|--all [--model <模型>]`      | 解除暂停                                                                                                                                                                                                                                       |
| `account remove <名称> [--purge] [--confirm <名称>]` | 默认只删账号库条目、保留 HOME；`--purge` 连同 HOME 一起删除（需输入账号名确认，只删账号目录内的 HOME）                                                                                                                                         |
| `doctor [--online]`                                  | 检查平台、配置、agy 版本、git、各账号的 HOME/钥匙串/凭据（只看是否存在）与暂停；`--online` 对每个账号真实运行一次 `agy models`                                                                                                                 |

登录时如果弹出“找不到用于储存 antigravity 的钥匙串”，点「取消」，**不要点「还原为默认」**（会重建你本人的登录钥匙串）。

### 配置文件（可选）

`<数据目录>/config.yaml`（或 `AGY_FLEET_CONFIG` 指定），字段全部可选，写错会启动失败并指出字段：

```yaml
accounts_dir: ~/.agy-fleet/accounts
worktree_root: ~/.agy-fleet/worktrees
per_account_concurrency: 1
global_concurrency: 4
idle_timeout_minutes: 30
turn_timeout_minutes: 30
# default_model: <模型 id>      # 不设则沿用 agy 默认
# default_effort: medium
permissions:
    outside_policy: deny # deny（默认）| ask：在客户端弹窗请你确认，客户端不支持时按拒绝
    ask_timeout_seconds: 300
    # allow_launcher_wildcards: false # 默认 false：拒绝“启动器/解释器 + *”的条目（见下方风险说明）
    commands: # 全局命令白名单，默认为空；优先写精确条目
        - git status
        - git diff --stat
        - ls * # 末尾 * 表示允许追加任意参数；git *、node *、npm * 这类条目等于允许任意代码执行
    repos:
        /path/to/repo: # 仓库根目录的绝对路径
            commands:
                - pnpm test
```

权限规则：

- 文件编辑只允许在本任务 worktree 内。请求里的所有路径（`locations` 以及参数里 `Path`、`TargetFile`、`Destination` 等像路径的键）都要在内。
- 以下位置一律拒绝、不询问（内置，配置无法关闭）：任何 `.git` 路径；agy-fleet 自己的数据目录、配置、账号库、账号 HOME；你 HOME 下的 `.gitconfig`、`.config/git`、`.ssh`、`.zshrc`、`.zprofile`、`.zshenv`、`.bashrc`、`.bash_profile`、`.profile`、`.npmrc`、`.aws`、`.gnupg`、`Library/LaunchAgents`、`.config/gh`（包括账号 HOME 里指向它们的链接）。
- 命令必须与白名单条目逐词相同（或匹配末尾 `*` 的前缀）。含 `;`、`&&`、`|`、`$()`、反引号、重定向、通配符、换行、`VAR=值` 前缀等的命令一律不算命中，按 `outside_policy` 处理。
- 询问弹窗里的命令与路径把换行和控制字符转义显示，并标出原文长度；原文太长看不全时不弹窗，直接拒绝。
- 规则只来自配置文件，MCP 工具参数无法放宽。被拒绝的操作进任务结果的 `denied`，经你在弹窗里批准的进 `approved`，都写入任务日志。

## 风险

使用前请知悉：

- **工作进程能读你能读的任何文件。** agy 读文件时不发权限请求（M0 实测），所以权限规则管不住“读”：工作进程可以读 `~/.ssh`、其他项目、任何你有权读的文件，并把内容写进汇报或发给模型服务。只在你能接受这一点的机器和账号上使用。
- **账号钥匙串不是加密保护。** 每个账号的独立钥匙串密码为空（为了不弹窗），令牌只受文件与目录权限保护：账号 HOME 为 `0700`，钥匙串文件为 `0600`。能以你的身份读文件的程序都能读到这些令牌。
- **白名单命令可能等于任意代码执行。**
    - 会执行仓库代码的命令（测试、构建、`npm run`、`make` 等）：工作进程可以先改测试或脚本再运行。
    - 带 `*` 的启动器/解释器条目——`git *`、`find *`、`node *`、`npm *`、`pnpm *`、`env *`、`xargs *`、`python *`、`sh *`、`bash *`、`ssh *` 等——参数本身就能指定要执行的代码（如 `git -c 'alias.x=!命令' x`、`git --upload-pack=命令 fetch`、`find -exec`、`node -e`）。这类条目默认加载失败；设置 `permissions.allow_launcher_wildcards: true` 才接受，并会在启动时与每个任务日志里给出警告。
    - 其他带 `*` 的条目允许任意参数（包括可能写文件的选项）。优先写精确条目。
- **多账号使用可能违反服务条款。** 本工具不做任何规避额度或风控的处理，与 Google 无关。

### 环境变量（均可选，优先于配置文件）

| 变量                                | 含义                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `AGY_FLEET_DATA_DIR`                | 数据目录，默认 `~/.agy-fleet`（账号库、租约、任务记录、日志、worktree）    |
| `AGY_FLEET_CONFIG`                  | 配置文件，默认 `<数据目录>/config.yaml`                                    |
| `AGY_FLEET_ACCOUNTS_FILE`           | 账号库文件，默认 `<数据目录>/accounts.json`                                |
| `AGY_FLEET_ACCOUNTS_DIR`            | `account add` 新建账号 HOME 的位置，默认 `<数据目录>/accounts`             |
| `AGY_FLEET_ACCOUNT_HOME`            | 额外登记一个已有的账号 HOME（开发测试用，名称取目录名）                    |
| `AGY_FLEET_WORKTREE_ROOT`           | worktree 根目录，默认 `<数据目录>/worktrees`                               |
| `AGY_FLEET_AGY_BIN`                 | agy 可执行文件，默认 `agy`                                                 |
| `AGY_FLEET_TURN_TIMEOUT_MINUTES`    | 单轮超时，默认 30                                                          |
| `AGY_FLEET_IDLE_TIMEOUT_MINUTES`    | 一轮结束后保留子进程等待续聊的时间，默认 30；超时后续聊自动 `session/load` |
| `AGY_FLEET_PER_ACCOUNT_CONCURRENCY` | 每账号同时运行的任务数，默认 1（账号库条目的 `maxConcurrency` 可覆盖）     |
| `AGY_FLEET_GLOBAL_CONCURRENCY`      | 所有账号合计的并发上限，默认 4                                             |

工具：`run_task`（可 `background`）、`wait_task`、`send_message`（返工）、`list_tasks`、`cancel_task`、`close_task`、`list_accounts`、`list_models`。每个任务一个 worktree 与分支 `agy-fleet/<task_id>`；工作进程不 commit/push。账号额度用尽或登录失效时，该“账号+模型”或整个账号会被暂停（`list_accounts` 可见原因），不会自动改派，用 `account resume` 或 `account login` 解除。

## 开发

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## 许可

MIT，见 [LICENSE](LICENSE)。
