import { describe, expect, it } from 'vitest';
import { FleetError } from '../errors.ts';
import { AgentProcess } from './process.ts';

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function firstLine(proc: AgentProcess): Promise<string> {
    return new Promise((resolve) => {
        let buf = '';
        proc.stdout.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            if (buf.includes('\n')) resolve(buf.split('\n')[0] ?? '');
        });
    });
}

const env = { PATH: process.env.PATH ?? '' };

describe('AgentProcess', () => {
    it('terminate 会连孙进程一起回收', async () => {
        const proc = await AgentProcess.start({
            command: 'sh',
            args: ['-c', 'sleep 300 & echo $!; wait'],
            cwd: process.cwd(),
            env,
        });
        const grandchild = Number(await firstLine(proc));
        expect(alive(grandchild)).toBe(true);
        await proc.terminate(500);
        expect(proc.running).toBe(false);
        await new Promise((r) => setTimeout(r, 100));
        expect(alive(grandchild)).toBe(false);
    });

    it('忽略 SIGTERM 的进程在宽限期后被强杀', async () => {
        const proc = await AgentProcess.start({
            command: 'sh',
            args: ['-c', "trap '' TERM; echo ready; while true; do sleep 1; done"],
            cwd: process.cwd(),
            env,
        });
        await firstLine(proc);
        const status = await proc.terminate(300);
        expect(status.signal).toBe('SIGKILL');
    });

    it('组长自己退出后，残留的孙进程也被清扫', async () => {
        const proc = await AgentProcess.start({
            command: 'sh',
            args: ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'],
            cwd: process.cwd(),
            env,
        });
        const grandchild = Number(await firstLine(proc));
        await proc.exited;
        await new Promise((r) => setTimeout(r, 100));
        expect(alive(grandchild)).toBe(false);
    });

    it('命令不存在时抛 agy_not_found', async () => {
        const error = await AgentProcess.start({
            command: '/nonexistent/agy-binary',
            args: [],
            cwd: process.cwd(),
            env,
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FleetError);
        expect((error as FleetError).code).toBe('agy_not_found');
    });
});
