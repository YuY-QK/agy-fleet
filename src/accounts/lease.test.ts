import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../fsutil.ts';
import { LeaseManager } from './lease.ts';

const holderScript = path.join(import.meta.dirname, 'lease-holder.fixture.mjs');
let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-lease-'));
});

afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
});

function manager(globalLimit = 10, ttlMs = 30_000): LeaseManager {
    return new LeaseManager({ dir, ttlMs, heartbeatMs: 3_600_000, globalLimit });
}

/** 起一个独立进程去抢租约，返回它打印的第一行。 */
function spawnHolder(account: string, limit: number, startAt: number): { child: ChildProcess; first: Promise<string> } {
    const child = spawn(process.execPath, [holderScript, dir, account, String(limit), String(startAt)], {
        stdio: ['pipe', 'pipe', 'inherit'],
    });
    children.push(child);
    const first = new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            if (out.includes('\n')) resolve(out.split('\n')[0] ?? '');
        });
        child.once('error', reject);
        child.once('exit', () => {
            resolve(out.split('\n')[0] ?? '');
        });
    });
    return { child, first };
}

describe('LeaseManager', () => {
    it('同一账号在上限内只发一份租约，释放后可再占用', () => {
        const leases = manager();
        const a = leases.acquire('acct', 't1', 1);
        expect(a.ok).toBe(true);
        const b = leases.acquire('acct', 't2', 1);
        expect(b).toMatchObject({ ok: false, reason: 'account_limit' });
        expect(leases.list('acct').map((l) => l.taskId)).toEqual(['t1']);
        if (a.ok) a.lease.release();
        expect(leases.acquire('acct', 't3', 1).ok).toBe(true);
    });

    it('每账号上限大于 1 时按上限发放；不同账号互不影响', () => {
        const leases = manager();
        expect(leases.acquire('a', 't1', 2).ok).toBe(true);
        expect(leases.acquire('a', 't2', 2).ok).toBe(true);
        expect(leases.acquire('a', 't3', 2).ok).toBe(false);
        expect(leases.acquire('b', 't4', 1).ok).toBe(true);
    });

    it('全局上限跨账号生效', () => {
        const leases = manager(2);
        expect(leases.acquire('a', 't1', 1).ok).toBe(true);
        expect(leases.acquire('b', 't2', 1).ok).toBe(true);
        expect(leases.acquire('c', 't3', 1)).toMatchObject({ ok: false, reason: 'global_limit' });
    });

    it('心跳过期的租约被回收（持有进程仍活着也一样）', () => {
        const leases = manager(10, 1000);
        const a = leases.acquire('acct', 't1', 1);
        expect(a.ok).toBe(true);
        const file = path.join(dir, readdirSync(dir).find((n) => n.endsWith('.json')) ?? '');
        const old = new Date(Date.now() - 60_000);
        utimesSync(file, old, old);
        expect(leases.list('acct')).toEqual([]);
        const b = leases.acquire('acct', 't2', 1);
        expect(b.ok).toBe(true);
        if (a.ok) expect(a.lease.lost).toBe(false); // 尚未心跳，不知道自己被回收
    });

    it('心跳让租约在超过 ttl 之后仍然有效', async () => {
        const fast = new LeaseManager({ dir, ttlMs: 500, heartbeatMs: 100, globalLimit: 10 });
        const a = fast.acquire('acct', 't1', 1);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(fast.list('acct')).toHaveLength(1);
        expect(fast.acquire('acct', 't2', 1).ok).toBe(false);
        if (a.ok) {
            expect(a.lease.lost).toBe(false);
            a.lease.release();
        }
    });

    it('releaseAll 释放本进程全部租约', () => {
        const leases = manager();
        leases.acquire('a', 't1', 1);
        leases.acquire('b', 't2', 1);
        leases.releaseAll();
        expect(leases.list()).toEqual([]);
    });

    it('多个进程同时抢同一账号：只有一个拿到', async () => {
        const startAt = Date.now() + 1500;
        const racers = Array.from({ length: 6 }, () => spawnHolder('shared', 1, startAt));
        const results = await Promise.all(racers.map((r) => r.first));
        expect(results.filter((r) => r === 'ACQUIRED')).toHaveLength(1);
        expect(results.filter((r) => r === 'BUSY:account_limit')).toHaveLength(5);
    });

    it('多个进程同时抢，每账号上限为 2：恰好两个拿到', async () => {
        const startAt = Date.now() + 1500;
        const racers = Array.from({ length: 6 }, () => spawnHolder('shared', 2, startAt));
        const results = await Promise.all(racers.map((r) => r.first));
        expect(results.filter((r) => r === 'ACQUIRED')).toHaveLength(2);
    });

    it('持有者进程被杀后，租约立即可被回收', async () => {
        const holder = spawnHolder('acct', 1, 0);
        expect(await holder.first).toBe('ACQUIRED');
        const leases = manager();
        expect(leases.acquire('acct', 'mine', 1).ok).toBe(false); // 持有者活着
        holder.child.kill('SIGKILL');
        await new Promise((resolve) => holder.child.once('exit', resolve));
        // 租约文件还在磁盘上，但持有者进程已不存在
        expect(readdirSync(dir).some((n) => n.endsWith('.json'))).toBe(true);
        expect(leases.list('acct')).toEqual([]);
        expect(leases.acquire('acct', 'mine', 1).ok).toBe(true);
    });
});

describe('withFileLock', () => {
    it('持有者已死的陈旧锁会被回收', () => {
        const lock = path.join(dir, 'x.lock');
        writeFileSync(lock, '2147483646:dead\n'); // 不存在的 pid
        expect(withFileLock(lock, () => 'ok', { timeoutMs: 1000 })).toBe('ok');
    });

    it('超时仍拿不到锁时报错', () => {
        const lock = path.join(dir, 'y.lock');
        withFileLock(lock, () => {
            expect(() => withFileLock(lock, () => 0, { timeoutMs: 100 })).toThrow('等待文件锁超时');
        });
    });
});
