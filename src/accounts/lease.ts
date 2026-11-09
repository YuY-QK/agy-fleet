import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pidAlive, withFileLock } from '../fsutil.ts';
import { log } from '../log.ts';

// 跨进程账号租约。
//  - 一份租约 = `leases/` 下的一个 JSON 文件，内容记录持有者的 pid、账号、任务；
//  - 持有者每隔一段时间刷新文件的修改时间（心跳）；
//  - “持有者进程已不存在”或“心跳超过 ttl”的租约视为失效，下一次占用时就地回收，所以进程崩溃不会卡死账号；
//  - 检查人数和创建租约在同一把文件锁里完成，多个 agy-fleet 进程同时抢占也不会超额。

export interface LeaseInfo {
    id: string;
    account: string;
    taskId: string;
    pid: number;
    startedAt: string;
}

export interface LeaseManagerOptions {
    dir: string;
    /** 心跳超过这么久没刷新就视为失效。 */
    ttlMs: number;
    heartbeatMs: number;
    /** 所有账号合计的并发上限。 */
    globalLimit: number;
}

export type AcquireResult =
    { ok: true; lease: Lease } | { ok: false; reason: 'account_limit' | 'global_limit'; holders: LeaseInfo[] };

export class Lease {
    readonly info: LeaseInfo;
    #file: string;
    #timer: NodeJS.Timeout | undefined;
    #lost = false;
    #released = false;
    #onRelease: () => void;

    constructor(info: LeaseInfo, file: string, heartbeatMs: number, onRelease: () => void) {
        this.info = info;
        this.#file = file;
        this.#onRelease = onRelease;
        this.#timer = setInterval(() => {
            this.#beat();
        }, heartbeatMs);
        this.#timer.unref();
    }

    /** 租约文件被别人回收（例如本进程长时间卡住导致心跳过期）。 */
    get lost(): boolean {
        return this.#lost;
    }

    #beat(): void {
        try {
            const now = new Date();
            utimesSync(this.#file, now, now);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.#lost = true;
                log.warn('账号租约已被回收（心跳过期）', { account: this.info.account, task: this.info.taskId });
                if (this.#timer !== undefined) clearInterval(this.#timer);
            }
        }
    }

    release(): void {
        if (this.#released) return;
        this.#released = true;
        if (this.#timer !== undefined) clearInterval(this.#timer);
        this.#onRelease();
        try {
            unlinkSync(this.#file);
        } catch {
            // 已被回收
        }
    }
}

interface Entry {
    info: LeaseInfo;
    file: string;
    live: boolean;
}

export class LeaseManager {
    readonly #options: LeaseManagerOptions;
    readonly #held = new Set<Lease>();

    constructor(options: LeaseManagerOptions) {
        this.#options = options;
    }

    /**
     * 为 `taskId` 占用 `account` 的一个并发名额；名额已满返回失败（不排队）。
     * `accountLimit` 为该账号同时允许的任务数。
     */
    acquire(account: string, taskId: string, accountLimit: number): AcquireResult {
        const { dir } = this.#options;
        mkdirSync(dir, { recursive: true });
        return withFileLock(path.join(dir, '.mutex'), () => {
            const live = this.#scan(true).filter((e) => e.live);
            const forAccount = live.filter((e) => e.info.account === account);
            if (forAccount.length >= accountLimit) {
                return { ok: false, reason: 'account_limit', holders: forAccount.map((e) => e.info) } as const;
            }
            if (live.length >= this.#options.globalLimit) {
                return { ok: false, reason: 'global_limit', holders: live.map((e) => e.info) } as const;
            }
            const info: LeaseInfo = {
                id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
                account,
                taskId,
                pid: process.pid,
                startedAt: new Date().toISOString(),
            };
            const file = path.join(dir, `${info.id}.json`);
            writeFileSync(file, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
            const lease = new Lease(info, file, this.#options.heartbeatMs, () => {
                this.#held.delete(lease);
            });
            this.#held.add(lease);
            return { ok: true, lease } as const;
        });
    }

    /** 当前有效的租约（不回收失效的）。 */
    list(account?: string): LeaseInfo[] {
        return this.#scan(false)
            .filter((e) => e.live && (account === undefined || e.info.account === account))
            .map((e) => e.info);
    }

    /** 释放本进程持有的全部租约（进程退出前调用）。 */
    releaseAll(): void {
        for (const lease of [...this.#held]) lease.release();
    }

    /** 读出所有租约文件；`reap` 为真时顺手删掉失效的。 */
    #scan(reap: boolean): Entry[] {
        const { dir, ttlMs } = this.#options;
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return [];
        }
        const entries: Entry[] = [];
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const file = path.join(dir, name);
            try {
                const ageMs = Date.now() - statSync(file).mtimeMs;
                const info = JSON.parse(readFileSync(file, 'utf8')) as LeaseInfo;
                const live = ageMs <= ttlMs && pidAlive(info.pid);
                if (!live && reap) unlinkSync(file);
                entries.push({ info, file, live });
            } catch {
                // 读不出来的文件：超过 ttl 才清理，避免误删正在写入的
                try {
                    if (reap && Date.now() - statSync(file).mtimeMs > ttlMs) unlinkSync(file);
                } catch {
                    // 已被别人处理
                }
            }
        }
        return entries;
    }
}
