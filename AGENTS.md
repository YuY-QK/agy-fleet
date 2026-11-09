# agy-fleet AI 协作约定

本文件是项目级入口，只定义本项目的文档路由、技能和命令。通用的协作方式、信息优先级和工程底线见全局规则（由 agent-kit 安装在用户目录）；具体业务规则、功能设计和技术方案写在下面路由到的权威文档里，不在本文件复制。

## 项目简介

通用、可公开安装的开源 MCP 服务器：让任何 MCP 客户端把编码任务分派给本机多个账号下的 Antigravity CLI（agy），通过 ACP 驱动，在隔离的 git worktree 里并行执行，权限按规则逐项审批。当前阶段：M1（单账号跑通）。

## 文档路由

如果有 `docs/HANDOFF.md`，最先读它：它写明上次会话停在哪里（内容合并进 `docs/progress.md` 后删掉）。开始工作前先读 `docs/progress.md`（现状、计划和待办），再按任务范围读取最少且必要的资料：

- 方案（范围、模块、权限规则、MCP 接口、里程碑、风险；已确认）：`docs/PLAN_v1.1.md`
- agy / ACP 的实测结论（权限请求字段、续聊、钥匙串做法）：`docs/acp-验证结论.md`
- 项目专属的开发规则和约束：`docs/AI_RULES.md`
- 当前可运行方式和真实结构：`README.md`、代码、配置和测试

还没有建立的文档，不要假设它的内容；需要时用 `idea-to-plan` 技能补上。

## 技能

通用技能已安装在用户级目录：`idea-to-plan`、`product-change`、`ui-experience`、`architecture-change`、`change-review`、`quality-testing`、`orchestrate`，以及技术栈技能（`flutter-development` 或 `single-file-web`）。

本项目专属技能放在 `.agents/skills/`（Codex）和 `.claude/skills/`（Claude Code），名称不要与通用技能重复：

- （暂无）

## 子线程

把工作拆给子线程时按 `orchestrate` 技能执行；通用的 `task-worker` 和 `repo-scout` 已包含通用规则。本项目专属的 agent 放在 `.claude/agents/`，名称不要与通用 agent 重复，里面只写本项目特有的内容（读哪份规格、负责哪些文件、跑哪些检查）：

- （暂无）

## 项目命令

- 格式化：`pnpm fmt`（检查：`pnpm fmt:check`）
- 静态分析：`pnpm typecheck`、`pnpm lint`
- 测试：`pnpm test`
- 运行：`pnpm build` 后 `node dist/cli.js mcp`（需要 `AGY_FLEET_ACCOUNT_HOME`，见 README）
- 无界面，不需要页面检查
