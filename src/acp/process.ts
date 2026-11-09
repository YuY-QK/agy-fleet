import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { FleetError } from '../errors.ts';

// 子进程生命周期。要点：
//  - 子进程自成一个进程组（detached），回收时对整个组发信号，这样 agy 再派生出的孙进程也不会残留；
//  - 先 SIGTERM 礼貌退出，宽限期过后对整个组 SIGKILL；
//  - 本进程自己退出时，同步地杀掉所有仍存活的组，避免 MCP 服务器被关掉后留下孤儿。

export interface AgentProcessOptions {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export interface ExitStatus {
    code: number | null;
    signal: NodeJS.Signals | null;
}

type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** 仍存活的进程组 id；由 exit 钩子兜底回收。 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
    try {
        process.kill(-pgid, signal);
        return true;
    } catch {
        return false; // ESRCH：整个组都已不存在
    }
}

function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.on('exit', () => {
        for (const pgid of liveGroups) signalGroup(pgid, 'SIGKILL');
    });
}

export class AgentProcess {
    readonly pid: number;
    readonly stdin: Writable;
    readonly stdout: Readable;
    /** 进程退出（或启动失败）后落定；永不 reject。 */
    readonly exited: Promise<ExitStatus>;

    #stderrTail = '';
    #done = false;

    private constructor(child: PipedChild, pid: number) {
        this.pid = pid;
        this.stdin = child.stdin;
        this.stdout = child.stdout;
        liveGroups.add(pid);
        installExitHook();

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            this.#stderrTail = (this.#stderrTail + chunk).slice(-4000);
        });
        // 对端提前关闭管道时写入会报 EPIPE；这里吞掉，由 exited 与请求超时反映真正的问题。
        child.stdin.on('error', () => undefined);

        // 组长一退出就清扫整个组：孙进程若还攥着管道，'close' 永远不会来。
        // 管道里已写出的数据不会丢，仍可被读完。
        child.once('exit', () => {
            this.#done = true;
            liveGroups.delete(pid);
            signalGroup(pid, 'SIGKILL');
        });
        this.exited = new Promise<ExitStatus>((resolve) => {
            child.once('close', (code, signal) => {
                resolve({ code, signal });
            });
        });
    }

    /** 启动进程；命令不存在时抛 `agy_not_found`。 */
    static async start(options: AgentProcessOptions): Promise<AgentProcess> {
        const child = spawn(options.command, [...options.args], {
            cwd: options.cwd,
            env: options.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
        });
        await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        }).catch((err: unknown) => {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                throw new FleetError('agy_not_found', `找不到可执行文件：${options.command}`);
            }
            throw new FleetError('agent_crashed', `无法启动 ${options.command}：${String(err)}`);
        });
        if (child.pid === undefined) throw new FleetError('agent_crashed', `启动 ${options.command} 后拿不到进程号`);
        return new AgentProcess(child, child.pid);
    }

    get running(): boolean {
        return !this.#done;
    }

    /** 最近一段 stderr，用来在报错里说明原因。 */
    get stderrTail(): string {
        return this.#stderrTail.trim();
    }

    /** 终止整个进程组并等到组长退出。已退出则直接返回。 */
    async terminate(graceMs = 3000): Promise<ExitStatus> {
        if (!this.#done) {
            signalGroup(this.pid, 'SIGTERM');
            const timer = setTimeout(() => signalGroup(this.pid, 'SIGKILL'), graceMs);
            try {
                return await this.exited;
            } finally {
                clearTimeout(timer);
            }
        }
        return this.exited;
    }
}
