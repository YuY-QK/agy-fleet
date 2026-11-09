// 测试用：独立进程里抢一份账号租约。用法：node lease-holder.fixture.mjs <dir> <account> <limit> <startAtMs>
// 抢到打印 ACQUIRED 并一直持有（等被杀或 stdin 关闭），否则打印 BUSY:<原因> 后退出。
import process from 'node:process';
import { LeaseManager } from './lease.ts';

const [dir, account, limit, startAt] = process.argv.slice(2);
const manager = new LeaseManager({ dir, ttlMs: 30_000, heartbeatMs: 1000, globalLimit: 100 });
while (Date.now() < Number(startAt)) {
    /* 对齐起跑线，让多个进程真正同时抢 */
}
const result = manager.acquire(account, `task-${String(process.pid)}`, Number(limit));
if (result.ok) {
    process.stdout.write('ACQUIRED\n');
    process.stdin.resume();
    process.stdin.on('end', () => {
        result.lease.release();
        process.exit(0);
    });
} else {
    process.stdout.write(`BUSY:${result.reason}\n`);
    process.exit(0);
}
