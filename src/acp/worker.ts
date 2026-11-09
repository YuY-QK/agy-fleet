import { StringDecoder } from 'node:string_decoder';
import type {
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionNotification,
    StopReason,
} from '@agentclientprotocol/sdk';
import { FleetError } from '../errors.ts';
import { AgentProcess } from './process.ts';

// 一个 ACP 会话的客户端侧。协议流程取自 spike/acp_probe*.py 与 docs/acp-验证结论.md：
//   initialize → session/new → session/prompt（期间收 session/update 通知、回应 session/request_permission）。
// 传输是“每行一个 JSON-RPC 消息”的 stdio；这里自带一个很小的 JSON-RPC 对端，不依赖 SDK 的连接层，
// 只借用 SDK 的类型定义。

const PROTOCOL_VERSION = 1;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;
/** 取消一轮后，等 agent 自己收尾的时间。 */
const CANCEL_GRACE_MS = 5_000;
/** 进程退出后，再等一下 stdout 把残留数据读完。 */
const DRAIN_WAIT_MS = 200;
const AUTH_HINT = /auth|log ?in|credential|unauthori[sz]ed|token|sign ?in/i;

const METHOD_NOT_FOUND = -32601;

export type PermissionHandler = (
    request: RequestPermissionRequest,
) => RequestPermissionResponse | Promise<RequestPermissionResponse>;

export interface WorkerOptions {
    command: string;
    args: readonly string[];
    /** 会话工作目录，即任务的 worktree。 */
    cwd: string;
    env: NodeJS.ProcessEnv;
    onUpdate: (notification: SessionNotification) => void;
    onPermission: PermissionHandler;
    /** 协议流量的一行摘要，用于任务日志（不含完整内容）。 */
    onTrace?: (event: string, detail?: Record<string, unknown>) => void;
    handshakeTimeoutMs?: number;
}

export interface TurnOptions {
    timeoutMs: number;
    signal?: AbortSignal;
}

interface Pending {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
}

interface RpcError {
    code?: number;
    message?: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AcpWorker {
    readonly sessionId: string;

    #proc: AgentProcess;
    #link: Link;

    private constructor(proc: AgentProcess, link: Link, sessionId: string) {
        this.#proc = proc;
        this.#link = link;
        this.sessionId = sessionId;
    }

    /** 启动 agent、完成握手并新建会话。任何一步失败都会回收进程。 */
    static async start(options: WorkerOptions): Promise<AcpWorker> {
        const proc = await AgentProcess.start({
            command: options.command,
            args: options.args,
            cwd: options.cwd,
            env: options.env,
        });
        const link = new Link(proc, options);
        const timeout = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
        try {
            await link.call(
                'initialize',
                {
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                },
                timeout,
            );
            const created = await link.call('session/new', { cwd: options.cwd, mcpServers: [] }, timeout);
            const sessionId = isObject(created) ? created.sessionId : undefined;
            if (typeof sessionId !== 'string' || sessionId === '') {
                throw new FleetError('agent_crashed', 'session/new 的应答里没有 sessionId');
            }
            return new AcpWorker(proc, link, sessionId);
        } catch (err) {
            await proc.terminate();
            throw link.classifyHandshakeError(err);
        }
    }

    /**
     * 发一轮提示并等到本轮结束，返回 stopReason。
     * 超时或被取消时先发 session/cancel 让 agent 收尾，再抛 `timeout` / `cancelled`；调用方随后应 `close()`。
     */
    async runTurn(text: string, options: TurnOptions): Promise<StopReason> {
        const link = this.#link;
        const turn = link.call('session/prompt', {
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text }],
        });

        let interrupted: 'timeout' | 'cancelled' | undefined;
        let timer: NodeJS.Timeout | undefined;
        const interrupt = new Promise<void>((resolve) => {
            const fire = (why: 'timeout' | 'cancelled'): void => {
                interrupted ??= why;
                resolve();
            };
            timer = setTimeout(() => {
                fire('timeout');
            }, options.timeoutMs);
            if (options.signal?.aborted === true) fire('cancelled');
            options.signal?.addEventListener(
                'abort',
                () => {
                    fire('cancelled');
                },
                { once: true },
            );
        });

        try {
            const outcome = await Promise.race([turn.then((value) => ({ value })), interrupt.then(() => undefined)]);
            if (outcome !== undefined) return parseStopReason(outcome.value);

            // 被打断：礼貌地取消，等一小会儿，然后无论结果都报告打断原因。
            link.setCancelling(true);
            link.notify('session/cancel', { sessionId: this.sessionId });
            await Promise.race([turn.catch(() => undefined), delay(CANCEL_GRACE_MS)]);
            const why = interrupted ?? 'cancelled';
            throw new FleetError(
                why,
                why === 'timeout' ? `单轮超过 ${String(Math.round(options.timeoutMs / 1000))} 秒，已取消` : '已取消',
            );
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            link.setCancelling(false);
            // 打断时 turn 可能仍悬着，避免未处理的 rejection。
            turn.catch(() => undefined);
        }
    }

    async close(): Promise<void> {
        this.#link.shutdown();
        await this.#proc.terminate();
    }
}

function parseStopReason(response: unknown): StopReason {
    const reason = isObject(response) ? response.stopReason : undefined;
    if (typeof reason !== 'string') throw new FleetError('agent_crashed', 'session/prompt 的应答里没有 stopReason');
    return reason as StopReason;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });
}

/** 一条 stdio 连接上的 JSON-RPC 收发。 */
class Link {
    #proc: AgentProcess;
    #options: WorkerOptions;
    #nextId = 1;
    #pending = new Map<number, Pending>();
    #cancelling = false;
    #closed = false;
    #buffer = '';

    constructor(proc: AgentProcess, options: WorkerOptions) {
        this.#proc = proc;
        this.#options = options;
        const decoder = new StringDecoder('utf8');
        proc.stdout.on('data', (chunk: Buffer) => {
            this.#buffer += decoder.write(chunk);
            let newline = this.#buffer.indexOf('\n');
            while (newline >= 0) {
                const line = this.#buffer.slice(0, newline).trim();
                this.#buffer = this.#buffer.slice(newline + 1);
                if (line !== '') this.#dispatch(line);
                newline = this.#buffer.indexOf('\n');
            }
        });
        void proc.exited.then(async (status) => {
            await delay(DRAIN_WAIT_MS);
            const tail = proc.stderrTail;
            const how = status.signal ?? `退出码 ${String(status.code)}`;
            this.#failAll(
                new FleetError(
                    'agent_crashed',
                    `agy 进程已退出（${how}）${tail === '' ? '' : `：${tail.slice(-500)}`}`,
                ),
            );
        });
    }

    setCancelling(value: boolean): void {
        this.#cancelling = value;
    }

    shutdown(): void {
        this.#closed = true;
        this.#failAll(new FleetError('cancelled', '连接已关闭'));
    }

    call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (this.#closed) {
                reject(new FleetError('agent_crashed', 'agy 连接已关闭'));
                return;
            }
            const id = this.#nextId++;
            const entry: Pending = { method, resolve, reject };
            if (timeoutMs !== undefined) {
                entry.timer = setTimeout(() => {
                    this.#pending.delete(id);
                    reject(
                        new FleetError('timeout', `${method} 在 ${String(Math.round(timeoutMs / 1000))} 秒内没有应答`),
                    );
                }, timeoutMs);
            }
            this.#pending.set(id, entry);
            this.#write({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method: string, params: unknown): void {
        this.#write({ jsonrpc: '2.0', method, params });
    }

    /** 握手期的失败：认证类消息归为未登录，其余保持原错误码。 */
    classifyHandshakeError(err: unknown): FleetError {
        if (err instanceof FleetError) {
            if (err.code === 'agent_crashed' && AUTH_HINT.test(err.message)) {
                return new FleetError('account_not_logged_in', err.message);
            }
            return err;
        }
        const message = err instanceof Error ? err.message : String(err);
        return new FleetError(AUTH_HINT.test(message) ? 'account_not_logged_in' : 'agent_crashed', message);
    }

    #write(message: Json): void {
        if (!this.#proc.running) return;
        this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
    }

    #failAll(error: Error): void {
        for (const [id, entry] of this.#pending) {
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.reject(error);
            this.#pending.delete(id);
        }
    }

    #dispatch(line: string): void {
        let message: unknown;
        try {
            message = JSON.parse(line);
        } catch {
            this.#options.onTrace?.('stdout_non_json', { head: line.slice(0, 200) });
            return;
        }
        if (!isObject(message)) return;
        const { id, method } = message;
        if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
            void this.#onRequest(id, method, message.params);
        } else if (typeof method === 'string') {
            this.#onNotification(method, message.params);
        } else if (typeof id === 'number') {
            this.#onResponse(id, message);
        }
    }

    #onResponse(id: number, message: Json): void {
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        if (isObject(message.error)) {
            const error = message.error as RpcError;
            entry.reject(
                new FleetError(
                    'agent_crashed',
                    `${entry.method} 失败：${error.message ?? '未知错误'}（${String(error.code)}）`,
                ),
            );
        } else {
            entry.resolve(message.result);
        }
    }

    #onNotification(method: string, params: unknown): void {
        if (method !== 'session/update') return;
        try {
            this.#options.onUpdate(params as SessionNotification);
        } catch (err) {
            this.#options.onTrace?.('update_handler_error', { error: String(err) });
        }
    }

    async #onRequest(id: number | string, method: string, params: unknown): Promise<void> {
        if (method !== 'session/request_permission') {
            this.#write({
                jsonrpc: '2.0',
                id,
                error: { code: METHOD_NOT_FOUND, message: `客户端不支持 ${method}` },
            });
            return;
        }
        let result: RequestPermissionResponse;
        if (this.#cancelling) {
            result = { outcome: { outcome: 'cancelled' } };
        } else {
            try {
                result = await this.#options.onPermission(params as RequestPermissionRequest);
            } catch (err) {
                // 判定出错时不放行。
                this.#options.onTrace?.('permission_handler_error', { error: String(err) });
                result = { outcome: { outcome: 'cancelled' } };
            }
        }
        this.#write({ jsonrpc: '2.0', id, result });
    }
}
