import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FleetConfig } from '../config.ts';
import { FleetError } from '../errors.ts';
import { log } from '../log.ts';
import { runTask } from '../tasks/run.ts';

/** 创建 MCP 服务器。M1 只有前台 `run_task`。 */
export function createServer(config: FleetConfig): McpServer {
    const server = new McpServer({ name: 'agy-fleet', version: '0.1.0' });

    server.registerTool(
        'run_task',
        {
            title: '派发编码任务给 agy',
            description:
                '在一个新的 git worktree（独立分支）里让 Antigravity CLI 完成一个编码任务，等到本轮结束后返回。' +
                '工作进程只能在该 worktree 内改文件，不能执行命令；被拒绝的操作列在 denied 里。' +
                '它不会 commit / push，请审查 worktree 的 diff 后自行合并。',
            inputSchema: {
                prompt: z.string().min(1).describe('任务说明，需自包含：目标、涉及的文件、完成标准'),
                repo: z.string().min(1).describe('目标 git 仓库（或其内任意子目录）的绝对路径'),
                description: z.string().optional().describe('一句话任务描述，仅用于日志'),
                base: z.string().optional().describe('worktree 的基准提交或分支，默认当前 HEAD'),
            },
        },
        async (args, extra) => {
            try {
                const result = await runTask(
                    config,
                    { prompt: args.prompt, repo: args.repo, base: args.base, description: args.description },
                    extra.signal,
                );
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err) {
                const code = err instanceof FleetError ? err.code : 'agent_crashed';
                const message = err instanceof Error ? err.message : String(err);
                log.error('run_task 失败', { code, message });
                return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }, null, 2) }] };
            }
        },
    );

    return server;
}
