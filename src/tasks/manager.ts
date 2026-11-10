import { randomBytes } from 'node:crypto';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStore, type AccountRecord } from '../accounts/store.ts';
import { unlockAccountKeychain } from '../accounts/credStore.ts';
import { LeaseManager, type Lease } from '../accounts/lease.ts';
import { listModels, type ModelInfo } from '../accounts/models.ts';
import { Collector } from '../acp/collector.ts';
import { AcpWorker } from '../acp/worker.ts';
import { commandRulesFor, type FleetConfig } from '../config.ts';
import { askBlocker } from '../policy/askText.ts';
import { classifyFailure, FleetError, pauseScopeOf } from '../errors.ts';
import { pidAlive } from '../fsutil.ts';
import { createWorktree, diffStat, removeWorktree, type Worktree } from '../git/worktree.ts';
import { log, openTaskLog, type TaskLog } from '../log.ts';
import {
    judgePermission,
    sensitiveUserRoots,
    toPermissionResponse,
    type ApprovedOperation,
    type DeniedOperation,
} from '../policy/permissions.ts';
import { TaskStore, type TaskRecord, type TaskStatus, type TurnResult } from './store.ts';

export interface RunTaskInput {
    prompt: string;
    repo: string;
    base?: string | undefined;
    description?: string | undefined;
    account?: string | undefined;
    model?: string | undefined;
    effort?: string | undefined;
    background?: boolean | undefined;
}

/** 对外的任务视图：任务元数据 + 最近一轮的结果（字段名即 JSON 键，见 PLAN §7）。 */
export interface TaskView extends Partial<TurnResult> {
    task_id: string;
    status: TaskStatus;
    account: string;
    model?: string;
    effort?: string;
    description?: string;
    worktree: string;
    branch: string;
    base_commit: string;
    session_id?: string;
    turns: number;
    created_at: string;
    updated_at: string;
    log_file: string;
    error?: { code: string; message: string };
    partial_report?: string;
}

export interface WaitOutcome {
    /** 超时仍在运行。 */
    still_running: boolean;
    task: TaskView;
}

export interface TaskSummary {
    task_id: string;
    status: TaskStatus;
    account: string;
    description?: string;
    branch: string;
    turns: number;
    running_for_s?: number;
    last_action?: string;
    error_code?: string;
    created_at: string;
    updated_at: string;
}

export interface AccountView {
    name: string;
    email?: string;
    status: 'idle' | 'busy' | 'paused';
    running_tasks: string[];
    max_concurrency: number;
    paused?: { code: string; reason: string; at: string };
    paused_models: Record<string, { code: string; reason: string; at: string }>;
}

/** 询问用户的结果。只有 `allow` 会放行；其余都按拒绝处理，并写明原因。 */
export type AskAnswer = 'allow' | 'deny' | 'timeout' | 'unsupported' | 'error';

/** 向用户询问一次规则外的操作（由 MCP 服务器经 elicitation 实现）。 */
export type PermissionAsker = (
    question: { taskId: string; account: string; operation: DeniedOperation },
    signal: AbortSignal,
) => Promise<AskAnswer>;

const ASK_ANSWER_TEXT: Record<Exclude<AskAnswer, 'allow'>, string> = {
    deny: '用户拒绝',
    timeout: '询问用户超时',
    unsupported: '客户端不支持弹窗确认（elicitation）',
    error: '询问用户失败',
};

/** 追加在任务说明前的固定约束（PLAN §6.6）；只在会话的第一轮加。 */
const WORKER_BRIEF = [
    '你是被派发来完成一个编码任务的工作进程。不要 commit、不要 push。',
    '完成后用简短条目汇报：做了什么、改了哪些文件、遗留问题。',
    '',
    '任务：',
].join('\n');

/** 内存里的一个任务：持久化记录之外，还有子进程、租约、本轮收集器等运行时状态。 */
interface Live {
    record: TaskRecord;
    taskLog: TaskLog;
    collector: Collector;
    denied: DeniedOperation[];
    approved: ApprovedOperation[];
    worker?: AcpWorker;
    lease?: Lease;
    abort?: AbortController;
    /** 当前这一轮；永不 reject，结束后状态已写入 record。 */
    turn?: Promise<void>;
    idleTimer?: NodeJS.Timeout;
}

function realOrResolved(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

function newTaskId(): string {
    return `t${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });
}

export class TaskManager {
    readonly accounts: AccountStore;
    readonly leases: LeaseManager;
    readonly store: TaskStore;
    readonly #config: FleetConfig;
    readonly #live = new Map<string, Live>();
    #asker: PermissionAsker | undefined;

    constructor(config: FleetConfig) {
        this.#config = config;
        this.accounts = new AccountStore(config.accountsFile);
        this.store = new TaskStore(config.taskDir);
        this.leases = new LeaseManager({
            dir: config.leaseDir,
            ttlMs: config.leaseTtlMs,
            heartbeatMs: config.leaseHeartbeatMs,
            globalLimit: config.globalConcurrency,
        });
    }

    /** 服务器启动时调用：登记环境变量指定的开发账号。 */
    init(): void {
        const home = this.#config.envAccountHome;
        if (home !== undefined) this.accounts.ensure({ name: path.basename(home), home });
    }

    /** 设置询问用户的方式（outside_policy 为 ask 时使用）；不设置则规则外的操作一律拒绝。 */
    setPermissionAsker(asker: PermissionAsker | undefined): void {
        this.#asker = asker;
    }

    // ---------- 账号 ----------

    listAccounts(): AccountView[] {
        return this.accounts.list().map((account) => {
            const running = this.leases.list(account.name);
            const limit = account.maxConcurrency ?? this.#config.perAccountConcurrency;
            const status = account.paused !== undefined ? 'paused' : running.length >= limit ? 'busy' : 'idle';
            return {
                name: account.name,
                ...(account.email !== undefined ? { email: account.email } : {}),
                status,
                running_tasks: running.map((l) => l.taskId),
                max_concurrency: limit,
                ...(account.paused !== undefined ? { paused: account.paused } : {}),
                paused_models: account.pausedModels ?? {},
            };
        });
    }

    async listModels(accountName?: string): Promise<{ account: string; models: ModelInfo[]; efforts: string[] }> {
        const accounts = this.accounts.list();
        const account = accountName === undefined ? accounts[0] : accounts.find((a) => a.name === accountName);
        if (account === undefined) {
            throw new FleetError(
                'invalid_input',
                accountName === undefined ? '账号库为空' : `账号不存在：${accountName}`,
            );
        }
        const models = await listModels(this.#config.agyBin, account.home);
        // 推理强度的可选档位随模型变化，agy 只在设置时校验；这里给出常见值。
        return { account: account.name, models, efforts: ['low', 'medium', 'high'] };
    }

    /** 选账号并占用租约。显式指定则只试这一个；否则从账号库里挑空闲、未暂停的。 */
    #acquire(
        requested: string | undefined,
        model: string | undefined,
        taskId: string,
    ): { account: AccountRecord; lease: Lease } {
        const all = this.accounts.list();
        let candidates: AccountRecord[];
        if (requested !== undefined) {
            const found = all.find((a) => a.name === requested);
            if (found === undefined) throw new FleetError('invalid_input', `账号库里没有账号：${requested}`);
            candidates = [found];
        } else {
            if (all.length === 0) {
                throw new FleetError('invalid_input', '账号库为空：请先在账号库（accounts.json）里登记账号');
            }
            candidates = all;
        }

        const usable: AccountRecord[] = [];
        const reasons: string[] = [];
        for (const account of candidates) {
            const pause = this.accounts.pauseFor(account.name, model);
            if (pause === undefined) usable.push(account);
            else reasons.push(`${account.name}：${pause.code}（${pause.reason.slice(0, 120)}）`);
        }
        if (usable.length === 0) {
            throw new FleetError('account_paused', `没有可用账号，已暂停：${reasons.join('；')}`);
        }

        // 先试在跑任务少的账号，把任务摊开。
        const load = (a: AccountRecord): number => this.leases.list(a.name).length;
        usable.sort((a, b) => load(a) - load(b));
        for (const account of usable) {
            const limit = account.maxConcurrency ?? this.#config.perAccountConcurrency;
            const result = this.leases.acquire(account.name, taskId, limit);
            if (result.ok) return { account, lease: result.lease };
            if (result.reason === 'global_limit') {
                throw new FleetError('account_busy', `已达全局并发上限（${String(this.#config.globalConcurrency)}）`);
            }
        }
        const names = usable.map((a) => a.name).join('、');
        throw new FleetError('account_busy', `账号都在忙：${names}（已达每账号并发上限）`);
    }

    // ---------- 任务 ----------

    async runTask(input: RunTaskInput, signal?: AbortSignal): Promise<TaskView> {
        if (!path.isAbsolute(input.repo)) {
            throw new FleetError('invalid_input', `repo 必须是绝对路径：${input.repo}`);
        }
        signal?.throwIfAborted();
        const model = input.model ?? this.#config.defaultModel;
        const effort = input.effort ?? this.#config.defaultEffort;
        const taskId = newTaskId();
        const { account, lease } = this.#acquire(input.account, model, taskId);

        let worktree: Worktree;
        try {
            worktree = await createWorktree({
                repo: input.repo,
                taskId,
                worktreeRoot: this.#config.worktreeRoot,
                ...(input.base !== undefined ? { base: input.base } : {}),
            });
        } catch (err) {
            lease.release();
            throw err;
        }

        const taskLog = openTaskLog(this.#config.logDir, taskId);
        taskLog.write('task_start', {
            account: account.name,
            repo: input.repo,
            description: input.description,
            model,
            effort,
        });
        for (const warning of this.#config.permissions.warnings) taskLog.write('permission_warning', { warning });
        taskLog.write('worktree_ready', { path: worktree.path, branch: worktree.branch, base: worktree.baseCommit });

        const now = new Date().toISOString();
        const record: TaskRecord = {
            id: taskId,
            status: 'running',
            account: account.name,
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            repo: input.repo,
            worktree,
            ownerPid: process.pid,
            turns: 0,
            createdAt: now,
            updatedAt: now,
            logFile: taskLog.file,
        };
        const live = this.#adopt(record, taskLog);
        this.#startTurn(live, `${WORKER_BRIEF}\n${input.prompt}`, lease);
        return this.#respond(live, input.background === true, signal);
    }

    async sendMessage(taskId: string, message: string, background: boolean, signal?: AbortSignal): Promise<TaskView> {
        const live = this.#owned(taskId);
        const record = live.record;
        if (record.status === 'running') {
            throw new FleetError('invalid_input', `任务 ${taskId} 正在运行，请先 wait_task 或 cancel_task`);
        }
        if (record.status === 'closed') throw new FleetError('invalid_input', `任务 ${taskId} 已关闭`);
        if (record.sessionId === undefined) {
            throw new FleetError('invalid_input', `任务 ${taskId} 没有可恢复的会话（失败于会话建立之前）`);
        }
        const account = this.accounts.get(record.account);
        if (account === undefined) throw new FleetError('invalid_input', `账号已不在账号库：${record.account}`);
        const pause = this.accounts.pauseFor(record.account, record.model);
        if (pause !== undefined) {
            throw new FleetError('account_paused', `账号 ${record.account} 已暂停：${pause.code}（${pause.reason}）`);
        }
        const limit = account.maxConcurrency ?? this.#config.perAccountConcurrency;
        const result = this.leases.acquire(record.account, taskId, limit);
        if (!result.ok) {
            throw new FleetError(
                'account_busy',
                result.reason === 'global_limit' ? '已达全局并发上限' : `账号 ${record.account} 正忙`,
                { taskId },
            );
        }
        this.#startTurn(live, message, result.lease);
        return this.#respond(live, background, signal);
    }

    async waitTask(taskId: string, timeoutS?: number): Promise<WaitOutcome> {
        const seconds = Math.min(Math.max(timeoutS ?? this.#config.waitDefaultS, 0), this.#config.waitMaxS);
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
            const live = this.#live.get(taskId);
            if (live?.turn !== undefined && live.record.status === 'running') {
                await Promise.race([live.turn, sleep(Math.max(deadline - Date.now(), 0))]);
            }
            const record = this.#current(taskId);
            if (record.status !== 'running') {
                if (record.status === 'failed') throw this.#failureOf(record);
                return { still_running: false, task: this.#view(record) };
            }
            if (Date.now() >= deadline) return { still_running: true, task: this.#view(record) };
            // 任务由别的进程在跑：轮询任务记录。
            if (live?.turn === undefined) await sleep(Math.min(300, Math.max(deadline - Date.now(), 0)));
        }
    }

    listTasks(status?: TaskStatus): TaskSummary[] {
        const records = this.store.list().map((r) => this.#live.get(r.id)?.record ?? this.#reconcile(r));
        return records
            .filter((r) => status === undefined || r.status === status)
            .map((r): TaskSummary => {
                const live = this.#live.get(r.id);
                const lastCall = live?.collector.toolCalls.at(-1);
                const lastAction = lastCall?.title ?? r.result?.stop_reason;
                return {
                    task_id: r.id,
                    status: r.status,
                    account: r.account,
                    ...(r.description !== undefined ? { description: r.description } : {}),
                    branch: r.worktree.branch,
                    turns: r.turns,
                    ...(r.status === 'running' && r.turnStartedAt !== undefined
                        ? { running_for_s: Math.round((Date.now() - Date.parse(r.turnStartedAt)) / 1000) }
                        : {}),
                    ...(lastAction !== undefined ? { last_action: lastAction } : {}),
                    ...(r.error !== undefined ? { error_code: r.error.code } : {}),
                    created_at: r.createdAt,
                    updated_at: r.updatedAt,
                };
            });
    }

    /** 取消正在运行的一轮：结束子进程，任务变为 failed(cancelled)，worktree 与会话保留，可 send_message 继续。 */
    async cancelTask(taskId: string): Promise<TaskView> {
        const live = this.#owned(taskId);
        if (live.record.status !== 'running' || live.turn === undefined || live.abort === undefined) {
            throw new FleetError('invalid_input', `任务 ${taskId} 没有正在运行的轮次（状态：${live.record.status}）`);
        }
        live.taskLog.write('cancel_requested');
        live.abort.abort();
        await live.turn;
        return this.#view(live.record);
    }

    /** 关闭任务：结束子进程与会话、删除 worktree（可选删分支）。记录保留，状态为 closed。 */
    async closeTask(
        taskId: string,
        deleteBranch: boolean,
    ): Promise<{ task_id: string; status: 'closed'; branch: string; branch_deleted: boolean }> {
        const live = this.#owned(taskId);
        const record = live.record;
        if (record.status === 'running' && live.turn !== undefined) {
            live.abort?.abort();
            await live.turn;
        }
        await this.#stopWorker(live);
        if (record.status !== 'closed') {
            await removeWorktree(record.worktree, deleteBranch);
            record.status = 'closed';
            delete record.turnStartedAt;
            this.store.save(record);
            live.taskLog.write('task_closed', { deleteBranch });
        }
        this.#live.delete(taskId);
        return { task_id: taskId, status: 'closed', branch: record.worktree.branch, branch_deleted: deleteBranch };
    }

    /** 进程退出前：取消在跑的轮次、关闭子进程、释放租约。 */
    async shutdown(): Promise<void> {
        const lives = [...this.#live.values()];
        for (const live of lives) live.abort?.abort();
        await Promise.allSettled(lives.map((live) => live.turn ?? Promise.resolve()));
        await Promise.allSettled(lives.map((live) => this.#stopWorker(live)));
        this.leases.releaseAll();
    }

    // ---------- 内部：任务生命周期 ----------

    #adopt(record: TaskRecord, taskLog: TaskLog): Live {
        const live: Live = { record, taskLog, collector: new Collector(), denied: [], approved: [] };
        this.#live.set(record.id, live);
        return live;
    }

    /** 开始一轮（lease 已占用）：状态置为 running，后台执行，结束时释放租约。 */
    #startTurn(live: Live, text: string, lease: Lease): void {
        const record = live.record;
        if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
        record.status = 'running';
        record.ownerPid = process.pid;
        record.turnStartedAt = new Date().toISOString();
        delete record.error;
        delete record.partialReport;
        this.store.save(record);
        live.lease = lease;
        live.abort = new AbortController();
        const signal = live.abort.signal;
        live.turn = this.#executeTurn(live, text, signal).finally(() => {
            lease.release();
            delete live.lease;
        });
    }

    async #executeTurn(live: Live, text: string, signal: AbortSignal): Promise<void> {
        const { record, taskLog, collector } = live;
        try {
            const account = this.accounts.get(record.account);
            if (account === undefined) throw new FleetError('invalid_input', `账号已不在账号库：${record.account}`);
            if (live.worker !== undefined && !live.worker.alive) {
                // 空闲期间子进程自己退出了：丢掉它，下面用 session/load 在新进程里恢复会话。
                live.taskLog.write('worker_gone_while_idle');
                await this.#stopWorker(live);
            }
            live.worker ??= await this.#startWorker(live, account.home);
            const worker = live.worker;
            if (record.sessionId !== worker.sessionId) {
                record.sessionId = worker.sessionId;
                this.store.save(record);
            }
            if (signal.aborted) throw new FleetError('cancelled', '已取消');

            live.denied = [];
            live.approved = [];
            collector.startTurn();
            const stopReason = await worker.runTurn(text, { timeoutMs: this.#config.turnTimeoutMs, signal });
            const diff = await diffStat(record.worktree);
            record.result = {
                stop_reason: stopReason,
                final_report: collector.finalText.trim(),
                diff,
                denied: live.denied,
                approved: live.approved,
                tool_calls: collector.toolCalls,
                usage: collector.usage ?? null,
            };
            record.turns += 1;
            record.status = 'idle';
            delete record.turnStartedAt;
            this.store.save(record);
            taskLog.write('turn_end', { stopReason, files: diff.totalFiles, denied: live.denied.length });
            this.#armIdleTimer(live);
        } catch (err) {
            try {
                await this.#fail(live, err);
            } catch (failErr) {
                // 兜底：善后本身出错也不能让 turn 承诺 reject，否则会变成未处理的 rejection。
                log.error('处理任务失败时又出错', { task: record.id, error: String(failErr) });
                record.status = 'failed';
            }
        }
    }

    async #startWorker(live: Live, home: string): Promise<AcpWorker> {
        const { record, taskLog, collector } = live;
        await unlockAccountKeychain(home);
        const worker = await AcpWorker.start({
            command: this.#config.agyBin,
            args: this.#config.agyArgs,
            cwd: record.worktree.path,
            env: { ...process.env, HOME: home },
            ...(record.sessionId !== undefined ? { resumeSessionId: record.sessionId } : {}),
            ...(record.model !== undefined ? { model: record.model } : {}),
            ...(record.effort !== undefined ? { effort: record.effort } : {}),
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
            onPermission: (request) => this.#decidePermission(live, request),
            onTrace: (event, detail) => {
                taskLog.write(event, detail);
            },
        });
        taskLog.write('session_ready', { session: worker.sessionId, resumed: record.sessionId !== undefined });
        return worker;
    }

    /**
     * 处理一次权限请求：先按规则判定；规则外且可询问时，按 outside_policy 决定拒绝还是询问用户。
     * 每次拒绝都进 denied，每次经用户批准都进 approved，两者都写任务日志。
     */
    async #decidePermission(live: Live, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const { record, taskLog } = live;
        const permissions = this.#config.permissions;
        const verdict = judgePermission(request.toolCall, record.worktree.path, {
            commands: commandRulesFor(permissions, record.worktree.repoRoot),
            protectedRoots: this.#protectedRoots(record.account),
        });
        if (verdict.allow) {
            taskLog.write('permission_allowed', {
                title: request.toolCall.title,
                ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}),
            });
            return toPermissionResponse(request, true);
        }
        const operation = verdict.denied;
        const blocker = verdict.askable && permissions.outsidePolicy === 'ask' ? askBlocker(operation) : undefined;
        if (blocker !== undefined) {
            // 原文过长：用户在弹窗里看不全，不能让他确认看不见的内容。
            const denied = { ...operation, reason: `${operation.reason}；${blocker}，未询问用户` };
            live.denied.push(denied);
            taskLog.write('permission_denied', { ...denied });
            return toPermissionResponse(request, false);
        }
        if (verdict.askable && permissions.outsidePolicy === 'ask') {
            taskLog.write('permission_ask', { ...operation });
            let answer: AskAnswer = 'unsupported';
            if (this.#asker !== undefined) {
                const signal = live.abort?.signal ?? new AbortController().signal;
                try {
                    answer = await this.#asker({ taskId: record.id, account: record.account, operation }, signal);
                } catch (err) {
                    log.warn('询问用户失败', { task: record.id, error: String(err) });
                    answer = 'error';
                }
            }
            if (answer === 'allow') {
                const approved: ApprovedOperation = {
                    kind: operation.kind,
                    tool: operation.tool,
                    target: operation.target,
                    note: `规则外（${operation.reason}），经用户批准`,
                };
                live.approved.push(approved);
                taskLog.write('permission_approved_by_user', { ...approved });
                return toPermissionResponse(request, true);
            }
            const denied = { ...operation, reason: `${operation.reason}；${ASK_ANSWER_TEXT[answer]}` };
            live.denied.push(denied);
            taskLog.write('permission_denied', { ...denied });
            return toPermissionResponse(request, false);
        }
        live.denied.push(operation);
        taskLog.write('permission_denied', { ...operation });
        return toPermissionResponse(request, false);
    }

    /**
     * worktree 外即使用户同意也不允许修改的位置：agy-fleet 的数据目录、配置文件、账号库、账号目录、本任务账号的 HOME，
     * 以及用户 HOME 下的敏感文件（见 SENSITIVE_USER_PATHS）。改这些等于让工作进程给自己放宽权限、拿到凭据，
     * 或埋下用户日后会执行的代码。内置，配置无法关闭。
     */
    #protectedRoots(accountName: string): string[] {
        const config = this.#config;
        const home = this.accounts.get(accountName)?.home;
        const roots = [config.dataDir, config.accountsFile, config.accountsDir, config.configFile, home].filter(
            (p): p is string => p !== undefined,
        );
        // 字面路径与真实路径都放进去：被比较的一方是真实路径，受保护位置自己若经过符号链接也要覆盖。
        return [
            ...new Set([
                ...roots.map((p) => path.resolve(p)),
                ...roots.map(realOrResolved),
                ...sensitiveUserRoots(os.homedir()),
            ]),
        ];
    }

    /** 一轮失败：分类、写日志、必要时暂停账号、回收子进程。worktree 与会话保留。 */
    async #fail(live: Live, err: unknown): Promise<void> {
        const { record, taskLog } = live;
        const failure = classifyFailure(err);
        // 原始错误文本完整写入任务日志，便于以后校正分类规则。
        taskLog.write('task_failed', {
            code: failure.code,
            error: failure.message,
            original: err instanceof Error ? err.message : String(err),
        });
        log.warn('任务失败，worktree 保留以便检查', { task: record.id, code: failure.code });

        const scope = pauseScopeOf(failure.code);
        if (scope !== undefined) {
            const info = { code: failure.code, reason: failure.message.slice(0, 500), at: new Date().toISOString() };
            try {
                if (scope === 'account') this.accounts.pauseAccount(record.account, info);
                else this.accounts.pauseModel(record.account, record.model, info);
                taskLog.write('account_paused', { account: record.account, scope, model: record.model });
            } catch (pauseErr) {
                log.error('写入账号暂停状态失败', { error: String(pauseErr) });
            }
        }

        await this.#stopWorker(live);
        record.status = 'failed';
        delete record.turnStartedAt;
        record.error = { code: failure.code, message: failure.message };
        const partial = live.collector.finalText.trim();
        if (partial !== '') record.partialReport = partial;
        this.store.save(record);
    }

    async #stopWorker(live: Live): Promise<void> {
        if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
        delete live.idleTimer;
        const worker = live.worker;
        delete live.worker;
        if (worker !== undefined) await worker.close();
    }

    /** 空闲超时：关闭子进程，会话留在 agy 那边，之后 send_message 用 session/load 恢复。 */
    #armIdleTimer(live: Live): void {
        if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
        live.idleTimer = setTimeout(() => {
            if (live.record.status !== 'idle') return;
            live.taskLog.write('idle_timeout', { afterMs: this.#config.idleTimeoutMs });
            void this.#stopWorker(live);
        }, this.#config.idleTimeoutMs);
        live.idleTimer.unref();
    }

    // ---------- 内部：读取与视图 ----------

    async #respond(live: Live, background: boolean, signal?: AbortSignal): Promise<TaskView> {
        if (background) return this.#view(live.record);
        const onAbort = (): void => {
            // 调用方放弃了这次请求（客户端取消）：等同于取消任务。
            if (live.record.status === 'running') live.abort?.abort();
        };
        if (signal?.aborted === true) onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            await live.turn;
        } finally {
            signal?.removeEventListener('abort', onAbort);
        }
        if (live.record.status === 'failed') throw this.#failureOf(live.record);
        return this.#view(live.record);
    }

    #failureOf(record: TaskRecord): FleetError {
        const error = record.error ?? { code: 'agent_crashed', message: '未知失败' };
        return new FleetError(error.code as FleetError['code'], error.message, {
            taskId: record.id,
            ...(record.partialReport !== undefined ? { partial: record.partialReport } : {}),
        });
    }

    /** 任务的最新记录：本进程在管的以内存为准，否则读磁盘并核对属主是否还活着。 */
    #current(taskId: string): TaskRecord {
        const live = this.#live.get(taskId);
        if (live !== undefined) return live.record;
        const record = this.store.load(taskId);
        if (record === undefined) throw new FleetError('invalid_input', `没有这个任务：${taskId}`);
        return this.#reconcile(record);
    }

    /** running 的任务如果属主进程已经不在了，说明被中断：标为 failed（会话保留，可继续）。 */
    #reconcile(record: TaskRecord): TaskRecord {
        if (record.status === 'running' && record.ownerPid !== process.pid && !pidAlive(record.ownerPid)) {
            record.status = 'failed';
            delete record.turnStartedAt;
            record.error = { code: 'agent_crashed', message: '负责该任务的 agy-fleet 进程已退出，任务被中断' };
            this.store.save(record);
        }
        return record;
    }

    /** 取得本进程可以操作的任务；属于另一个仍在运行的 agy-fleet 进程的任务只能查看。 */
    #owned(taskId: string): Live {
        const existing = this.#live.get(taskId);
        if (existing !== undefined) return existing;
        const record = this.#current(taskId);
        if (record.status !== 'closed' && record.ownerPid !== process.pid && pidAlive(record.ownerPid)) {
            throw new FleetError(
                'invalid_input',
                `任务 ${taskId} 属于另一个正在运行的 agy-fleet 进程（pid ${String(record.ownerPid)}），本进程只能查看`,
            );
        }
        // 前任进程已退出：接手。
        record.ownerPid = process.pid;
        this.store.save(record);
        return this.#adopt(record, openTaskLog(this.#config.logDir, taskId));
    }

    #view(record: TaskRecord): TaskView {
        return {
            task_id: record.id,
            status: record.status,
            account: record.account,
            ...(record.model !== undefined ? { model: record.model } : {}),
            ...(record.effort !== undefined ? { effort: record.effort } : {}),
            ...(record.description !== undefined ? { description: record.description } : {}),
            worktree: record.worktree.path,
            branch: record.worktree.branch,
            base_commit: record.worktree.baseCommit,
            ...(record.sessionId !== undefined ? { session_id: record.sessionId } : {}),
            turns: record.turns,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
            log_file: record.logFile,
            ...(record.error !== undefined ? { error: record.error } : {}),
            ...(record.partialReport !== undefined ? { partial_report: record.partialReport } : {}),
            ...record.result,
        };
    }
}
