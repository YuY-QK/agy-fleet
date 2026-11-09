import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type FleetConfig } from '../config.ts';
import { FleetError } from '../errors.ts';
import { TaskManager } from './manager.ts';

const mockAgent = path.join(import.meta.dirname, '..', 'acp', 'mock-agent.fixture.mjs');

let root: string;
let repo: string;
let managers: TaskManager[];
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

/** 模拟 agent 的行为由环境变量决定；子进程继承本进程环境。 */
function mock(mode: string, extra: Record<string, string> = {}): void {
    for (const [key, value] of Object.entries({
        MOCK_MODE: mode,
        MOCK_STATE_DIR: path.join(root, 'mockstate'),
        ...extra,
    })) {
        if (!(key in savedEnv)) savedEnv[key] = process.env[key];
        process.env[key] = value;
    }
}

function setup(accountNames: string[], overrides: Partial<FleetConfig> = {}): TaskManager {
    const accounts = accountNames.map((name) => {
        const home = path.join(root, 'homes', name);
        mkdirSync(home, { recursive: true });
        return { name, home };
    });
    writeFileSync(path.join(root, 'data', 'accounts.json'), JSON.stringify({ version: 1, accounts }));
    return newManager(overrides);
}

function newManager(overrides: Partial<FleetConfig> = {}): TaskManager {
    const config = {
        ...loadConfig({ AGY_FLEET_DATA_DIR: path.join(root, 'data') }),
        agyBin: process.execPath,
        agyArgs: [mockAgent],
        ...overrides,
    };
    const manager = new TaskManager(config);
    managers.push(manager);
    return manager;
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
    return promise.then(
        () => undefined,
        (e: unknown) => (e instanceof FleetError ? e.code : `非 FleetError：${String(e)}`),
    );
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-mgr-')));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    mkdirSync(path.join(root, 'mockstate'), { recursive: true });
    repo = path.join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'README.md'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    managers = [];
    mock('work');
});

afterEach(async () => {
    await Promise.allSettled(managers.map((m) => m.shutdown()));
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

describe('前台任务与状态机', () => {
    it('run_task 前台：跑完一轮进入 idle，返回 diff，租约已释放，记录已持久化', async () => {
        const manager = setup(['a1']);
        const view = await manager.runTask({ prompt: '写点东西', repo });
        expect(view).toMatchObject({ status: 'idle', account: 'a1', turns: 1, stop_reason: 'end_turn' });
        expect(view.diff?.files.map((f) => f.path)).toEqual(['work.txt']);
        expect(view.final_report).toContain('loaded=false turns=1');
        expect(manager.leases.list()).toEqual([]);
        expect(existsSync(path.join(root, 'data', 'tasks', `${view.task_id}.json`))).toBe(true);
        expect(view.branch).toBe(`agy-fleet/${view.task_id}`);
    });

    it('send_message：同一会话继续（子进程仍在），turns 递增', async () => {
        const manager = setup(['a1']);
        const first = await manager.runTask({ prompt: '第一轮', repo });
        const second = await manager.sendMessage(first.task_id, '请修改', false);
        expect(second).toMatchObject({ status: 'idle', turns: 2, session_id: first.session_id });
        expect(second.final_report).toContain('loaded=false turns=2');
    });

    it('状态机的非法转移：运行中不能 send_message / 对 idle 不能 cancel / 关闭后不能续聊 / 未知任务', async () => {
        const manager = setup(['a1']);
        mock('work', { MOCK_DELAY_MS: '600' });
        const running = await manager.runTask({ prompt: 'x', repo, background: true });
        expect(running.status).toBe('running');
        expect(await code(manager.sendMessage(running.task_id, 'y', false))).toBe('invalid_input');
        await manager.waitTask(running.task_id, 10);
        expect(await code(manager.cancelTask(running.task_id))).toBe('invalid_input');
        await manager.closeTask(running.task_id, false);
        expect(await code(manager.sendMessage(running.task_id, 'y', false))).toBe('invalid_input');
        expect(await code(manager.waitTask('tnope', 1))).toBe('invalid_input');
    });

    it('相对路径的 repo 被拒绝', async () => {
        const manager = setup(['a1']);
        expect(await code(manager.runTask({ prompt: 'x', repo: 'relative/path' }))).toBe('invalid_input');
    });

    it('model / effort 传给 agent；无效值得到 invalid_input 且不留下租约', async () => {
        const manager = setup(['a1']);
        const view = await manager.runTask({ prompt: 'x', repo, model: 'm-1', effort: 'low' });
        expect(view.final_report).toContain('model=m-1 effort=low');
        expect(await code(manager.runTask({ prompt: 'x', repo, model: 'bad' }))).toBe('invalid_input');
        expect(manager.leases.list()).toEqual([]);
    });
});

describe('后台任务、等待与取消', () => {
    it('background 立即返回 running；wait_task 超时返回仍在运行，再等拿到结果', async () => {
        const manager = setup(['a1']);
        mock('work', { MOCK_DELAY_MS: '1200' });
        const started = await manager.runTask({ prompt: 'x', repo, background: true });
        expect(started.status).toBe('running');
        const early = await manager.waitTask(started.task_id, 0.2);
        expect(early.still_running).toBe(true);
        expect(manager.listTasks('running').map((t) => t.task_id)).toEqual([started.task_id]);
        const done = await manager.waitTask(started.task_id, 10);
        expect(done.still_running).toBe(false);
        expect(done.task).toMatchObject({ status: 'idle', turns: 1 });
    });

    it('wait_task 对失败的任务抛出带错误码与 task_id 的错误', async () => {
        const manager = setup(['a1']);
        mock('quota');
        const started = await manager.runTask({ prompt: 'x', repo, background: true });
        const error = await manager.waitTask(started.task_id, 10).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FleetError);
        expect(error).toMatchObject({ code: 'quota_exhausted', taskId: started.task_id });
    });

    it('cancel_task：结束子进程、释放租约、状态 failed(cancelled)；之后可 close_task 清理 worktree', async () => {
        const manager = setup(['a1']);
        mock('hang');
        const started = await manager.runTask({ prompt: 'x', repo, background: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(manager.leases.list('a1')).toHaveLength(1);
        const cancelled = await manager.cancelTask(started.task_id);
        expect(cancelled).toMatchObject({ status: 'failed', error: { code: 'cancelled' } });
        expect(manager.leases.list()).toEqual([]);
        expect(existsSync(started.worktree)).toBe(true);

        const closed = await manager.closeTask(started.task_id, true);
        expect(closed).toMatchObject({ status: 'closed', branch_deleted: true });
        expect(existsSync(started.worktree)).toBe(false);
        expect(git(repo, 'branch', '--list', started.branch)).toBe('');
        expect(manager.listTasks('closed')).toHaveLength(1);
    });

    it('close_task 默认保留分支；对运行中的任务会先取消', async () => {
        const manager = setup(['a1']);
        mock('hang');
        const started = await manager.runTask({ prompt: 'x', repo, background: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const closed = await manager.closeTask(started.task_id, false);
        expect(closed.branch_deleted).toBe(false);
        expect(existsSync(started.worktree)).toBe(false);
        expect(git(repo, 'branch', '--list', started.branch)).toContain(started.branch);
        expect(manager.leases.list()).toEqual([]);
    });

    it('前台请求被客户端取消（AbortSignal）等同于取消任务', async () => {
        const manager = setup(['a1']);
        mock('hang');
        const controller = new AbortController();
        const run = manager.runTask({ prompt: 'x', repo }, controller.signal);
        setTimeout(() => {
            controller.abort();
        }, 300);
        expect(await code(run)).toBe('cancelled');
        expect(manager.leases.list()).toEqual([]);
        expect(manager.listTasks('failed')).toHaveLength(1);
    });
});

describe('续聊恢复（空闲超时后 session/load）', () => {
    it('空闲超时关闭子进程；send_message 用新进程 load 同一会话，对话延续', async () => {
        const manager = setup(['a1'], { idleTimeoutMs: 300 });
        const first = await manager.runTask({ prompt: '第一轮', repo });
        expect(first.final_report).toContain('loaded=false turns=1');
        await new Promise((resolve) => setTimeout(resolve, 800)); // 超过空闲超时
        expect(readFileSync(first.log_file, 'utf8')).toContain('idle_timeout');
        const second = await manager.sendMessage(first.task_id, '返工', false);
        expect(second.session_id).toBe(first.session_id);
        // loaded=true：这是新进程；turns=2：会话历史（在 agent 那边）延续
        expect(second.final_report).toContain('loaded=true turns=2');
        expect(second.turns).toBe(2);
    });

    it('空闲期间子进程自己退出了：send_message 在新进程里 load 恢复，而不是卡住', async () => {
        const manager = setup(['a1']);
        mock('work', { MOCK_EXIT_AFTER_PROMPT: '1' });
        const first = await manager.runTask({ prompt: '第一轮', repo });
        await new Promise((resolve) => setTimeout(resolve, 500));
        mock('work', { MOCK_EXIT_AFTER_PROMPT: '0' });
        const second = await manager.sendMessage(first.task_id, '返工', false);
        expect(second.final_report).toContain('loaded=true turns=2');
    });

    it('取消后的任务也能用 send_message 恢复会话继续', async () => {
        const manager = setup(['a1'], { idleTimeoutMs: 200 });
        const first = await manager.runTask({ prompt: '第一轮', repo });
        await new Promise((resolve) => setTimeout(resolve, 600)); // 等旧子进程因空闲退出，下一轮才会用新的模拟行为
        mock('hang');
        const running = await manager.sendMessage(first.task_id, '会被取消', true);
        expect(running.status).toBe('running');
        await new Promise((resolve) => setTimeout(resolve, 300));
        await manager.cancelTask(first.task_id);
        mock('work');
        const resumed = await manager.sendMessage(first.task_id, '继续', false);
        expect(resumed).toMatchObject({ status: 'idle' });
        expect(resumed.final_report).toContain('loaded=true');
    });

    it('进程重启后（新的 TaskManager）能看到任务结果，并用 load 续聊', async () => {
        const manager = setup(['a1']);
        const first = await manager.runTask({ prompt: '第一轮', repo });
        await manager.shutdown(); // 本进程“退出”：子进程回收，记录保留

        const restarted = newManager();
        const listed = restarted.listTasks();
        expect(listed.map((t) => [t.task_id, t.status])).toEqual([[first.task_id, 'idle']]);
        const waited = await restarted.waitTask(first.task_id, 1);
        expect(waited.task.final_report).toContain('turns=1');
        const second = await restarted.sendMessage(first.task_id, '返工', false);
        expect(second.final_report).toContain('loaded=true turns=2');
    });

    it('属主进程已死的 running 任务在重启后标为 failed(agent_crashed)，仍可续聊', async () => {
        const manager = setup(['a1']);
        const first = await manager.runTask({ prompt: '第一轮', repo });
        const file = path.join(root, 'data', 'tasks', `${first.task_id}.json`);
        const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        writeFileSync(file, JSON.stringify({ ...record, status: 'running', ownerPid: 2147483646 }));

        const restarted = newManager();
        expect(restarted.listTasks()[0]).toMatchObject({ status: 'failed', error_code: 'agent_crashed' });
        const resumed = await restarted.sendMessage(first.task_id, '继续', false);
        expect(resumed.status).toBe('idle');
    });

    it('属于另一个仍在运行的进程的任务只能查看，不能操作', async () => {
        const manager = setup(['a1']);
        const first = await manager.runTask({ prompt: '第一轮', repo });
        const file = path.join(root, 'data', 'tasks', `${first.task_id}.json`);
        const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        writeFileSync(file, JSON.stringify({ ...record, ownerPid: process.ppid })); // 父进程必然存活
        await manager.shutdown();

        const other = newManager();
        expect((await other.waitTask(first.task_id, 1)).task.status).toBe('idle'); // 可查看
        expect(await code(other.sendMessage(first.task_id, 'x', false))).toBe('invalid_input');
        expect(await code(other.closeTask(first.task_id, false))).toBe('invalid_input');
    });
});

describe('账号选择、租约与并发', () => {
    it('缺省选空闲账号：两个后台任务落在不同账号，第三个得到 account_busy', async () => {
        const manager = setup(['a1', 'a2']);
        mock('work', { MOCK_DELAY_MS: '1500' });
        const t1 = await manager.runTask({ prompt: 'x', repo, background: true });
        const t2 = await manager.runTask({ prompt: 'y', repo, background: true });
        expect(new Set([t1.account, t2.account])).toEqual(new Set(['a1', 'a2']));
        expect(await code(manager.runTask({ prompt: 'z', repo }))).toBe('account_busy');
        expect(manager.listAccounts().map((a) => a.status)).toEqual(['busy', 'busy']);
        await manager.waitTask(t1.task_id, 10);
        await manager.waitTask(t2.task_id, 10);
        expect(manager.listAccounts().map((a) => a.status)).toEqual(['idle', 'idle']);
    });

    it('指定账号：忙碌返回 account_busy，不存在返回 invalid_input，空库返回 invalid_input', async () => {
        const manager = setup(['a1', 'a2']);
        mock('work', { MOCK_DELAY_MS: '1000' });
        const running = await manager.runTask({ prompt: 'x', repo, account: 'a1', background: true });
        expect(running.account).toBe('a1');
        expect(await code(manager.runTask({ prompt: 'y', repo, account: 'a1' }))).toBe('account_busy');
        expect(await code(manager.runTask({ prompt: 'y', repo, account: 'nope' }))).toBe('invalid_input');
        await manager.waitTask(running.task_id, 10);

        writeFileSync(path.join(root, 'data', 'accounts.json'), JSON.stringify({ accounts: [] }));
        expect(await code(manager.runTask({ prompt: 'y', repo }))).toBe('invalid_input');
    });

    it('每账号并发上限可配置（maxConcurrency 覆盖全局默认）', async () => {
        const manager = setup(['a1']);
        const file = path.join(root, 'data', 'accounts.json');
        const data = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Record<string, unknown>[] };
        writeFileSync(file, JSON.stringify({ accounts: [{ ...data.accounts[0], maxConcurrency: 2 }] }));
        mock('work', { MOCK_DELAY_MS: '1000' });
        const a = await manager.runTask({ prompt: 'x', repo, background: true });
        const b = await manager.runTask({ prompt: 'y', repo, background: true });
        expect(await code(manager.runTask({ prompt: 'z', repo }))).toBe('account_busy');
        await manager.waitTask(a.task_id, 10);
        await manager.waitTask(b.task_id, 10);
    });

    it('全局并发上限跨账号生效', async () => {
        const manager = setup(['a1', 'a2', 'a3'], { globalConcurrency: 2 });
        mock('work', { MOCK_DELAY_MS: '1000' });
        const a = await manager.runTask({ prompt: 'x', repo, background: true });
        const b = await manager.runTask({ prompt: 'y', repo, background: true });
        const error = await manager.runTask({ prompt: 'z', repo }).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'account_busy' });
        expect((error as Error).message).toContain('全局');
        await manager.waitTask(a.task_id, 10);
        await manager.waitTask(b.task_id, 10);
    });

    it('两个 TaskManager（模拟两个 agy-fleet 进程）共享租约：不抢同一账号', async () => {
        const first = setup(['a1']);
        const second = newManager();
        mock('work', { MOCK_DELAY_MS: '1000' });
        const running = await first.runTask({ prompt: 'x', repo, background: true });
        expect(await code(second.runTask({ prompt: 'y', repo, account: 'a1' }))).toBe('account_busy');
        await first.waitTask(running.task_id, 10);
        expect((await second.runTask({ prompt: 'y', repo, account: 'a1' })).status).toBe('idle');
    });

    it('send_message 时账号被别的任务占着：account_busy，任务仍是 idle', async () => {
        const manager = setup(['a1']);
        const first = await manager.runTask({ prompt: '第一轮', repo });
        mock('work', { MOCK_DELAY_MS: '1000' });
        const other = await manager.runTask({ prompt: '别的', repo, background: true });
        expect(await code(manager.sendMessage(first.task_id, '返工', false))).toBe('account_busy');
        expect(manager.listTasks('idle').map((t) => t.task_id)).toEqual([first.task_id]);
        await manager.waitTask(other.task_id, 10);
    });
});

describe('错误分类与暂停', () => {
    it('额度用尽：任务 failed(quota_exhausted)，暂停“账号+模型”；别的模型仍可用，默认模型被拒', async () => {
        const manager = setup(['a1']);
        mock('quota');
        const error = await manager.runTask({ prompt: 'x', repo, model: 'm-1' }).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'quota_exhausted' });
        expect((error as FleetError).taskId).toBeDefined();

        const account = manager.listAccounts()[0];
        expect(account?.status).toBe('idle'); // 账号本身没停
        expect(Object.keys(account?.paused_models ?? {})).toEqual(['m-1']);

        mock('work');
        expect(await code(manager.runTask({ prompt: 'x', repo, model: 'm-1' }))).toBe('account_paused');
        expect((await manager.runTask({ prompt: 'x', repo, model: 'm-2' })).status).toBe('idle');
        expect((await manager.runTask({ prompt: 'x', repo })).status).toBe('idle'); // 默认模型没被暂停
    });

    it('原始错误文本完整写入任务日志', async () => {
        const manager = setup(['a1']);
        mock('quota');
        const error = (await manager.runTask({ prompt: 'x', repo }).catch((e: unknown) => e)) as FleetError;
        const logText = readFileSync(path.join(root, 'data', 'logs', `${error.taskId ?? ''}.log`), 'utf8');
        expect(logText).toContain('task_failed');
        expect(logText).toContain('RESOURCE_EXHAUSTED');
        expect(logText).toContain('account_paused');
    });

    it('登录失效：暂停整个账号，所有模型都被拒，list_accounts 可见原因', async () => {
        const manager = setup(['a1', 'a2']);
        mock('authexp');
        expect(await code(manager.runTask({ prompt: 'x', repo, account: 'a1' }))).toBe('auth_expired');
        mock('work');
        expect(await code(manager.runTask({ prompt: 'x', repo, account: 'a1', model: 'm-2' }))).toBe('account_paused');
        const a1 = manager.listAccounts().find((a) => a.name === 'a1');
        expect(a1).toMatchObject({ status: 'paused', paused: { code: 'auth_expired' } });
        // 缺省选号会绕开被暂停的账号
        expect((await manager.runTask({ prompt: 'x', repo })).account).toBe('a2');
    });

    it('握手阶段未登录：暂停整个账号', async () => {
        const manager = setup(['a1']);
        mock('authfail');
        expect(await code(manager.runTask({ prompt: 'x', repo }))).toBe('account_not_logged_in');
        expect(manager.listAccounts()[0]?.status).toBe('paused');
    });

    it('所有账号都被暂停时缺省选号返回 account_paused；resume 与 AGY_FLEET_RESUME 可解除', async () => {
        const manager = setup(['a1']);
        mock('authexp');
        await code(manager.runTask({ prompt: 'x', repo }));
        mock('work');
        expect(await code(manager.runTask({ prompt: 'x', repo }))).toBe('account_paused');

        manager.accounts.resume('a1');
        expect((await manager.runTask({ prompt: 'x', repo })).status).toBe('idle');

        mock('authexp');
        await code(manager.runTask({ prompt: 'x', repo }));
        mock('work');
        const restarted = newManager({ resumeAccounts: ['a1'] });
        restarted.init();
        expect((await restarted.runTask({ prompt: 'x', repo })).status).toBe('idle');
    });

    it('超时、取消不暂停账号', async () => {
        const manager = setup(['a1'], { turnTimeoutMs: 300 });
        mock('hang');
        expect(await code(manager.runTask({ prompt: 'x', repo }))).toBe('timeout');
        expect(manager.listAccounts()[0]).toMatchObject({ status: 'idle', paused_models: {} });
    });

    it('被暂停的任务再 send_message 返回 account_paused', async () => {
        const manager = setup(['a1']);
        const first = await manager.runTask({ prompt: '第一轮', repo });
        manager.accounts.pauseAccount('a1', { code: 'auth_expired', reason: 'x', at: new Date().toISOString() });
        expect(await code(manager.sendMessage(first.task_id, '返工', false))).toBe('account_paused');
    });
});

describe('开发账号登记与恢复', () => {
    it('AGY_FLEET_ACCOUNT_HOME 指定的账号在 init 时登记进账号库', () => {
        const home = path.join(root, 'homes', 'dev');
        mkdirSync(home, { recursive: true });
        const manager = newManager({ envAccountHome: home });
        manager.init();
        expect(manager.accounts.list()).toEqual([{ name: 'dev', home }]);
    });
});
