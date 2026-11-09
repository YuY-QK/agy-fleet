import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { FleetError } from '../errors.ts';
import { judgePermission, toPermissionResponse } from '../policy/permissions.ts';
import { Collector } from './collector.ts';
import { AcpWorker, type WorkerOptions } from './worker.ts';

const agentScript = path.join(import.meta.dirname, 'mock-agent.fixture.mjs');
const worktree = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-worker-')));

function options(mode: string, extra: Partial<WorkerOptions> = {}): WorkerOptions {
    return {
        command: process.execPath,
        args: [agentScript],
        cwd: worktree,
        env: { PATH: process.env.PATH ?? '', MOCK_MODE: mode, MOCK_EDIT_PATH: path.join(worktree, 'a.txt') },
        onUpdate: () => undefined,
        onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        ...extra,
    };
}

async function failure(promise: Promise<unknown>): Promise<FleetError> {
    const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FleetError);
    return error as FleetError;
}

describe('AcpWorker', () => {
    it('握手后跑一轮：权限请求按判定应答，更新进入 collector', async () => {
        const collector = new Collector();
        const denied: string[] = [];
        const worker = await AcpWorker.start(
            options('ok', {
                onUpdate: (n: SessionNotification) => {
                    collector.handle(n);
                },
                onPermission: (request) => {
                    const verdict = judgePermission(request.toolCall, worktree);
                    if (!verdict.allow) denied.push(verdict.denied.kind);
                    return toPermissionResponse(request, verdict.allow);
                },
            }),
        );
        try {
            expect(worker.sessionId).toBe('s1');
            collector.startTurn();
            const stop = await worker.runTurn('go', { timeoutMs: 10_000 });
            expect(stop).toBe('end_turn');
            expect(collector.text).toBe('开始。选择:allow,deny');
            expect(denied).toEqual(['execute']);
        } finally {
            await worker.close();
        }
    });

    it('认证类的握手错误归为 account_not_logged_in', async () => {
        expect((await failure(AcpWorker.start(options('authfail')))).code).toBe('account_not_logged_in');
    });

    it('握手超时抛 timeout，并回收进程', async () => {
        const error = await failure(AcpWorker.start(options('silent', { handshakeTimeoutMs: 300 })));
        expect(error.code).toBe('timeout');
    });

    it('agent 在握手时崩溃抛 agent_crashed', async () => {
        expect((await failure(AcpWorker.start(options('crash')))).code).toBe('agent_crashed');
    });

    it('单轮超时：发 session/cancel 后抛 timeout', async () => {
        const worker = await AcpWorker.start(options('hang'));
        try {
            expect((await failure(worker.runTurn('go', { timeoutMs: 200 }))).code).toBe('timeout');
        } finally {
            await worker.close();
        }
    });

    it('调用方取消：抛 cancelled', async () => {
        const worker = await AcpWorker.start(options('hang'));
        const controller = new AbortController();
        try {
            const turn = worker.runTurn('go', { timeoutMs: 10_000, signal: controller.signal });
            setTimeout(() => {
                controller.abort();
            }, 100);
            expect((await failure(turn)).code).toBe('cancelled');
        } finally {
            await worker.close();
        }
    });

    it('model/effort 通过 session/set_config_option 设置；无效值归为 invalid_input', async () => {
        const collector = new Collector();
        const worker = await AcpWorker.start(
            options('work', {
                model: 'claude-sonnet-4-6',
                effort: 'high',
                onUpdate: (n: SessionNotification) => {
                    collector.handle(n);
                },
            }),
        );
        try {
            collector.startTurn();
            await worker.runTurn('go', { timeoutMs: 10_000 });
            expect(collector.text).toContain('model=claude-sonnet-4-6 effort=high');
        } finally {
            await worker.close();
        }
        expect((await failure(AcpWorker.start(options('work', { model: 'bad' })))).code).toBe('invalid_input');
    });

    it('新进程用 session/load 恢复会话：历史重放不进本轮输出，对话得以延续', async () => {
        const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-mockstate-'));
        const env = {
            PATH: process.env.PATH ?? '',
            MOCK_MODE: 'work',
            MOCK_STATE_DIR: stateDir,
            MOCK_SESSION_ID: 'sess-1',
        };
        const first = new Collector();
        const a = await AcpWorker.start(
            options('work', {
                env,
                onUpdate: (n: SessionNotification) => {
                    first.handle(n);
                },
            }),
        );
        try {
            first.startTurn();
            await a.runTurn('第一轮', { timeoutMs: 10_000 });
            expect(first.text).toContain('loaded=false turns=1');
        } finally {
            await a.close();
        }

        const second = new Collector();
        const b = await AcpWorker.start(
            options('work', {
                env,
                resumeSessionId: a.sessionId,
                onUpdate: (n: SessionNotification) => {
                    second.handle(n);
                },
            }),
        );
        try {
            expect(b.sessionId).toBe('sess-1');
            second.startTurn();
            await b.runTurn('第二轮', { timeoutMs: 10_000 });
            // 同一会话的第 2 轮；重放的“旧历史”没有混进来
            expect(second.text).toBe('完成。loaded=true turns=2 model=default effort=default');
        } finally {
            await b.close();
        }
    });

    it('恢复一个不存在的会话会失败', async () => {
        const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-mockstate-'));
        const env = { PATH: process.env.PATH ?? '', MOCK_MODE: 'work', MOCK_STATE_DIR: stateDir };
        const error = await failure(AcpWorker.start(options('work', { env, resumeSessionId: 'nope' })));
        expect(error.message).toContain('session not found');
    });

    it('session/prompt 的错误应答带上 data 原文', async () => {
        const worker = await AcpWorker.start(options('quota'));
        try {
            const error = await failure(worker.runTurn('go', { timeoutMs: 5000 }));
            expect(error.message).toContain('RESOURCE_EXHAUSTED');
        } finally {
            await worker.close();
        }
    });
});
