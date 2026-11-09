import { randomBytes } from 'node:crypto';
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import path from 'node:path';

// 跨进程共享文件的小工具：同步阻塞的文件锁、原子写、进程存活检查。
// 全部同步实现，临界区只做几次小文件读写，保证“检查并占用”不会被同进程内的其他异步代码打断。

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
    Atomics.wait(sleepCell, 0, 0, ms);
}

/** 进程是否存活；无权限发信号（EPERM）也说明进程存在。 */
export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export interface LockOptions {
    /** 等锁的最长时间。 */
    timeoutMs?: number;
    /** 锁文件超过这个时间没动静即视为陈旧（持有者通常已崩溃）。 */
    staleMs?: number;
}

function readLockHolder(lockFile: string): { raw: string; pid: number } | undefined {
    try {
        const raw = readFileSync(lockFile, 'utf8');
        return { raw, pid: Number.parseInt(raw, 10) };
    } catch {
        return undefined;
    }
}

/** 锁文件的持有者已死或太久没动静则清除，返回是否做了清除。 */
function breakStaleLock(lockFile: string, staleMs: number): boolean {
    const holder = readLockHolder(lockFile);
    if (holder === undefined) return true; // 刚被释放，直接重试
    let ageMs: number;
    try {
        ageMs = Date.now() - statSync(lockFile).mtimeMs;
    } catch {
        return true;
    }
    const dead = Number.isInteger(holder.pid) && holder.pid > 0 && !pidAlive(holder.pid);
    if (!dead && ageMs <= staleMs) return false;
    // 再确认一次内容没变，才挪走；挪走比直接删更不容易误伤刚拿到锁的新持有者。
    if (readLockHolder(lockFile)?.raw !== holder.raw) return true;
    const graveyard = `${lockFile}.stale-${randomBytes(4).toString('hex')}`;
    try {
        renameSync(lockFile, graveyard);
        unlinkSync(graveyard);
    } catch {
        // 已被别人处理
    }
    return true;
}

/** 持锁执行 `fn`（同步）。锁文件内容以持有者 pid 开头，持有者崩溃后会被后来者回收。 */
export function withFileLock<T>(lockFile: string, fn: () => T, options: LockOptions = {}): T {
    const timeoutMs = options.timeoutMs ?? 5000;
    const staleMs = options.staleMs ?? 10_000;
    mkdirSync(path.dirname(lockFile), { recursive: true });
    const token = `${String(process.pid)}:${randomBytes(6).toString('hex')}\n`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const fd = openSync(lockFile, 'wx');
            writeSync(fd, token);
            closeSync(fd);
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            if (breakStaleLock(lockFile, staleMs)) continue;
            if (Date.now() > deadline) throw new Error(`等待文件锁超时：${lockFile}`, { cause: err });
            sleepSync(5 + Math.floor(Math.random() * 15));
        }
    }
    try {
        return fn();
    } finally {
        try {
            if (readFileSync(lockFile, 'utf8') === token) unlinkSync(lockFile);
        } catch {
            // 锁已被回收或删除，无需处理
        }
    }
}

/** 先写临时文件再改名，读者永远看不到写了一半的内容。 */
export function writeFileAtomic(file: string, content: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
}
