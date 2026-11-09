import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitResultSchema, ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FleetError } from '../errors.ts';
import { log } from '../log.ts';
import type { AskAnswer, PermissionAsker, TaskManager } from '../tasks/manager.ts';

const STATUS = z.enum(['running', 'idle', 'failed', 'closed']);

function ok(payload: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** 失败统一为 MCP 工具错误：code、message，可选 task_id 与部分输出（PLAN §7）。 */
function fail(tool: string, err: unknown): CallToolResult {
    const code = err instanceof FleetError ? err.code : 'agent_crashed';
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${tool} 失败`, { code, message });
    const body = {
        code,
        message,
        ...(err instanceof FleetError && err.taskId !== undefined ? { task_id: err.taskId } : {}),
        ...(err instanceof FleetError && err.partial !== undefined ? { partial_report: err.partial } : {}),
    };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}

/** MCP 请求超时的错误码（SDK 把它定义成枚举，McpError.code 是普通数字）。 */
const REQUEST_TIMEOUT: number = ErrorCode.RequestTimeout;

const KIND_TEXT: Record<string, string> = {
    edit: '修改文件',
    delete: '删除文件',
    move: '移动文件',
    execute: '执行命令',
};

/** 弹窗里的文本来自工作进程，过长时截断，避免把提示语挤出视野。 */
function clip(text: string, max = 1500): string {
    return text.length <= max
        ? text
        : `${text.slice(0, max)}…（已截断，共 ${String(text.length)} 字符，完整内容见任务日志）`;
}

/**
 * 用 MCP elicitation 询问用户是否允许一次规则外的操作。
 * 客户端没有声明 elicitation 能力时不发请求，直接返回 unsupported（按拒绝处理）。
 * 直接发 `elicitation/create` 而不用 SDK 的 elicitInput：旧版客户端只声明 `elicitation: {}`（等同表单），
 * elicitInput 会因为缺少 `form` 字段而拒绝。
 */
function elicitationAsker(server: McpServer, timeoutMs: number): PermissionAsker {
    return async ({ taskId, account, operation }, signal): Promise<AskAnswer> => {
        if (server.server.getClientCapabilities()?.elicitation === undefined) return 'unsupported';
        const what = KIND_TEXT[operation.kind] ?? `“${operation.kind}”类操作`;
        const message =
            `agy-fleet：任务 ${taskId}（账号 ${account}）请求${what}，超出权限规则：\n\n` +
            `${clip(operation.target)}\n\n原因：${clip(operation.reason)}\n\n只允许这一次吗？不回应或取消都按拒绝处理。`;
        try {
            const result = await server.server.request(
                {
                    method: 'elicitation/create',
                    params: {
                        mode: 'form',
                        message,
                        requestedSchema: {
                            type: 'object',
                            properties: {
                                decision: {
                                    type: 'string',
                                    title: '决定',
                                    oneOf: [
                                        { const: 'deny', title: '拒绝' },
                                        { const: 'allow', title: '允许这一次' },
                                    ],
                                },
                            },
                            required: ['decision'],
                        },
                    },
                },
                ElicitResultSchema,
                { timeout: timeoutMs, signal },
            );
            // 只有明确“接受且选了允许”才放行；其余（拒绝、取消、内容不符）一律按拒绝。
            return result.action === 'accept' && result.content?.decision === 'allow' ? 'allow' : 'deny';
        } catch (err) {
            if (err instanceof McpError && err.code === REQUEST_TIMEOUT) return 'timeout';
            log.warn('elicitation 失败，按拒绝处理', { task: taskId, error: String(err) });
            return 'error';
        }
    };
}

/** 创建 MCP 服务器，工具全部委托给 TaskManager；规则外操作的询问经 elicitation 交给用户。 */
export function createServer(manager: TaskManager, options: { askTimeoutMs?: number } = {}): McpServer {
    const server = new McpServer({ name: 'agy-fleet', version: '0.3.0' });
    manager.setPermissionAsker(elicitationAsker(server, options.askTimeoutMs ?? 300_000));

    server.registerTool(
        'run_task',
        {
            title: '派发编码任务给 agy',
            description:
                '在一个新的 git worktree（独立分支）里让 Antigravity CLI 完成一个编码任务。' +
                '默认等到本轮结束再返回；background=true 则立即返回 task_id，之后用 wait_task 取结果。' +
                '工作进程只能在该 worktree 内改文件、只能执行配置文件白名单里的命令；规则外的操作按配置拒绝或请用户确认，' +
                '被拒绝的列在 denied 里，经用户批准的列在 approved 里。权限规则只能由使用者在配置文件里改，不能通过参数放宽。' +
                '它不会 commit / push，请审查 worktree 的 diff 后自行合并；不满意用 send_message 返工，完成后 close_task。',
            inputSchema: {
                prompt: z.string().min(1).describe('任务说明，需自包含：目标、涉及的文件、完成标准'),
                repo: z.string().min(1).describe('目标 git 仓库（或其内任意子目录）的绝对路径'),
                description: z.string().optional().describe('一句话任务描述，用于日志和 list_tasks'),
                base: z.string().optional().describe('worktree 的基准提交或分支，默认当前 HEAD'),
                account: z.string().optional().describe('指定账号名；缺省时从账号库取空闲账号（见 list_accounts）'),
                model: z.string().optional().describe('模型 id（见 list_models）；缺省沿用 agy 默认'),
                effort: z
                    .string()
                    .optional()
                    .describe('推理强度（如 low/medium/high，可选档位随模型而异）；缺省沿用默认'),
                background: z.boolean().optional().describe('true：立即返回，用 wait_task 取结果'),
            },
        },
        async (args, extra) => {
            try {
                return ok(await manager.runTask(args, extra.signal));
            } catch (err) {
                return fail('run_task', err);
            }
        },
    );

    server.registerTool(
        'send_message',
        {
            title: '在同一会话里追加指示（返工）',
            description:
                '对状态为 idle（或已失败但有会话）的任务追加一轮指示，保留之前的全部上下文。' +
                '子进程已因空闲关闭时会自动用 session/load 恢复会话。',
            inputSchema: {
                task_id: z.string().min(1),
                message: z.string().min(1).describe('修改意见，需自包含'),
                background: z.boolean().optional().describe('true：立即返回，用 wait_task 取结果'),
            },
        },
        async (args, extra) => {
            try {
                return ok(
                    await manager.sendMessage(args.task_id, args.message, args.background === true, extra.signal),
                );
            } catch (err) {
                return fail('send_message', err);
            }
        },
    );

    server.registerTool(
        'wait_task',
        {
            title: '等待任务本轮结束',
            description:
                '等待后台任务本轮结束。单次等待有上限；超时返回 still_running=true 而不是报错，可再次调用。' +
                '任务失败时返回工具错误（带错误码与 task_id）。',
            inputSchema: {
                task_id: z.string().min(1),
                timeout_s: z.number().positive().optional().describe('本次最多等待的秒数（有上限）'),
            },
        },
        async (args) => {
            try {
                const outcome = await manager.waitTask(args.task_id, args.timeout_s);
                return ok({ still_running: outcome.still_running, ...outcome.task });
            } catch (err) {
                return fail('wait_task', err);
            }
        },
    );

    server.registerTool(
        'list_tasks',
        {
            title: '列出任务',
            description: '列出任务（含已重启前的）：状态、账号、已运行时长、最近动作。',
            inputSchema: { status: STATUS.optional().describe('只看某个状态') },
        },
        (args) => {
            try {
                return ok(manager.listTasks(args.status));
            } catch (err) {
                return fail('list_tasks', err);
            }
        },
    );

    server.registerTool(
        'cancel_task',
        {
            title: '取消正在运行的一轮',
            description:
                '取消任务当前这一轮并结束子进程。任务变为 failed(cancelled)，worktree 与会话保留，之后仍可 send_message 继续或 close_task 清理。',
            inputSchema: { task_id: z.string().min(1) },
        },
        async (args) => {
            try {
                return ok(await manager.cancelTask(args.task_id));
            } catch (err) {
                return fail('cancel_task', err);
            }
        },
    );

    server.registerTool(
        'close_task',
        {
            title: '关闭任务并清理',
            description:
                '关闭任务的会话并删除 worktree。分支默认保留（合并前不要删）；delete_branch=true 一并删除分支。',
            inputSchema: {
                task_id: z.string().min(1),
                delete_branch: z.boolean().optional().describe('同时删除分支 agy-fleet/<task_id>'),
            },
        },
        async (args) => {
            try {
                return ok(await manager.closeTask(args.task_id, args.delete_branch === true));
            } catch (err) {
                return fail('close_task', err);
            }
        },
    );

    server.registerTool(
        'list_accounts',
        {
            title: '列出账号',
            description: '账号库里的账号：状态（idle/busy/paused）、暂停原因、正在跑的任务。',
            inputSchema: {},
        },
        () => {
            try {
                return ok(manager.listAccounts());
            } catch (err) {
                return fail('list_accounts', err);
            }
        },
    );

    server.registerTool(
        'list_models',
        {
            title: '列出可用模型',
            description: '用某个账号查询可用模型（缺省取账号库第一个账号）及常见的推理强度。',
            inputSchema: { account: z.string().optional() },
        },
        async (args) => {
            try {
                return ok(await manager.listModels(args.account));
            } catch (err) {
                return fail('list_models', err);
            }
        },
    );

    return server;
}
