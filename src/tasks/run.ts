import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { unlockAccountKeychain } from '../accounts/credStore.ts';
import { Collector, type ToolCallRecord, type UsageSnapshot } from '../acp/collector.ts';
import { AcpWorker } from '../acp/worker.ts';
import type { FleetConfig } from '../config.ts';
import { FleetError } from '../errors.ts';
import { createWorktree, diffStat, type DiffStat } from '../git/worktree.ts';
import { log, openTaskLog } from '../log.ts';
import { judgePermission, toPermissionResponse, type DeniedOperation } from '../policy/permissions.ts';

export interface RunTaskInput {
    prompt: string;
    repo: string;
    base?: string | undefined;
    description?: string | undefined;
}

/** `run_task` 的返回内容（字段名即 JSON 键，见 PLAN §7）。 */
export interface RunTaskResult {
    task_id: string;
    account: string;
    worktree: string;
    branch: string;
    base_commit: string;
    stop_reason: string;
    final_report: string;
    diff: DiffStat;
    denied: DeniedOperation[];
    tool_calls: ToolCallRecord[];
    usage: UsageSnapshot | null;
    log_file: string;
}

/** 追加在任务说明前的固定约束（PLAN §6.6）。 */
const WORKER_BRIEF = [
    '你是被派发来完成一个编码任务的工作进程。不要 commit、不要 push。',
    '完成后用简短条目汇报：做了什么、改了哪些文件、遗留问题。',
    '',
    '任务：',
].join('\n');

function newTaskId(): string {
    return `t${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

/** 前台执行一个任务：建 worktree → 启动 agy → 跑一轮 → 汇总 diff 与被拒操作。 */
export async function runTask(config: FleetConfig, input: RunTaskInput, signal?: AbortSignal): Promise<RunTaskResult> {
    if (!path.isAbsolute(input.repo)) {
        throw new FleetError('invalid_input', `repo 必须是绝对路径：${input.repo}`);
    }
    signal?.throwIfAborted();

    const taskId = newTaskId();
    const taskLog = openTaskLog(config.logDir, taskId);
    taskLog.write('task_start', { account: config.accountName, repo: input.repo, description: input.description });

    const worktree = await createWorktree({
        repo: input.repo,
        taskId,
        worktreeRoot: config.worktreeRoot,
        ...(input.base !== undefined ? { base: input.base } : {}),
    });
    taskLog.write('worktree_ready', { path: worktree.path, branch: worktree.branch, base: worktree.baseCommit });

    await unlockAccountKeychain(config.accountHome);

    const collector = new Collector();
    const denied: DeniedOperation[] = [];

    const worker = await AcpWorker.start({
        command: config.agyBin,
        args: ['acp'],
        cwd: worktree.path,
        env: { ...process.env, HOME: config.accountHome },
        onUpdate: (notification) => {
            collector.handle(notification);
            const update = notification.update;
            if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
                taskLog.write('tool', {
                    event: update.sessionUpdate,
                    id: update.toolCallId,
                    title: update.title,
                    status: update.status,
                });
            }
        },
        onPermission: (request) => {
            const verdict = judgePermission(request.toolCall, worktree.path);
            if (verdict.allow) {
                taskLog.write('permission_allowed', { title: request.toolCall.title });
            } else {
                denied.push(verdict.denied);
                taskLog.write('permission_denied', { ...verdict.denied });
            }
            return toPermissionResponse(request, verdict);
        },
        onTrace: (event, detail) => {
            taskLog.write(event, detail);
        },
    });
    taskLog.write('session_ready', { session: worker.sessionId });

    try {
        collector.startTurn();
        const stopReason = await worker.runTurn(`${WORKER_BRIEF}\n${input.prompt}`, {
            timeoutMs: config.turnTimeoutMs,
            ...(signal !== undefined ? { signal } : {}),
        });
        const diff = await diffStat(worktree);
        taskLog.write('task_end', { stopReason, files: diff.totalFiles, denied: denied.length });
        return {
            task_id: taskId,
            account: config.accountName,
            worktree: worktree.path,
            branch: worktree.branch,
            base_commit: worktree.baseCommit,
            stop_reason: stopReason,
            final_report: collector.finalText.trim(),
            diff,
            denied,
            tool_calls: collector.toolCalls,
            usage: collector.usage ?? null,
            log_file: taskLog.file,
        };
    } catch (err) {
        taskLog.write('task_failed', { error: err instanceof Error ? err.message : String(err) });
        log.warn('任务失败，worktree 保留以便检查', { task: taskId, worktree: worktree.path });
        throw err;
    } finally {
        await worker.close();
    }
}
