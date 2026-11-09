/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- 测试里直接读取工具返回的 JSON */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';
import { TaskManager } from '../tasks/manager.ts';
import { createServer } from './server.ts';

const mockAgent = path.join(import.meta.dirname, '..', 'acp', 'mock-agent.fixture.mjs');
let root: string;
let manager: TaskManager;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: any }> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { isError: result.isError === true, body: JSON.parse(content[0]?.text ?? 'null') };
}

beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-srv-')));
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo });
    };
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const home = path.join(root, 'home');
    mkdirSync(home);
    process.env.MOCK_MODE = 'work';
    process.env.MOCK_STATE_DIR = root;
    manager = new TaskManager({
        ...loadConfig({ AGY_FLEET_DATA_DIR: path.join(root, 'data'), AGY_FLEET_ACCOUNT_HOME: home }),
        agyBin: process.execPath,
        agyArgs: [mockAgent],
    });
    manager.init();
    const server = createServer(manager);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'MOCK_MODE');
    Reflect.deleteProperty(process.env, 'MOCK_STATE_DIR');
});

describe('MCP 工具', () => {
    it('注册了 PLAN §7 的全部工具', async () => {
        const names = (await client.listTools()).tools.map((t) => t.name).sort();
        expect(names).toEqual(
            [
                'cancel_task',
                'close_task',
                'list_accounts',
                'list_models',
                'list_tasks',
                'run_task',
                'send_message',
                'wait_task',
            ].sort(),
        );
    });

    it('后台派发 → wait_task → send_message → list_tasks → close_task 的完整流程', async () => {
        const repo = path.join(root, 'repo');
        expect((await call('list_accounts')).body[0]).toMatchObject({ name: 'home', status: 'idle' });

        const started = await call('run_task', { prompt: '干活', repo, background: true, description: '演示' });
        expect(started.body.status).toBe('running');
        const id = started.body.task_id as string;

        const waited = await call('wait_task', { task_id: id, timeout_s: 10 });
        expect(waited.body).toMatchObject({ still_running: false, status: 'idle', turns: 1 });

        const again = await call('send_message', { task_id: id, message: '返工' });
        expect(again.body).toMatchObject({ status: 'idle', turns: 2 });

        const listed = await call('list_tasks', { status: 'idle' });
        expect(listed.body).toHaveLength(1);
        expect(listed.body[0]).toMatchObject({ task_id: id, description: '演示' });

        expect((await call('close_task', { task_id: id, delete_branch: true })).body.status).toBe('closed');
    });

    it('失败以工具错误返回：code、message、task_id', async () => {
        process.env.MOCK_MODE = 'quota';
        const failed = await call('run_task', { prompt: 'x', repo: path.join(root, 'repo') });
        expect(failed.isError).toBe(true);
        expect(failed.body).toMatchObject({ code: 'quota_exhausted' });
        expect(failed.body.task_id).toBeDefined();
        const missing = await call('wait_task', { task_id: 'tnope' });
        expect(missing).toMatchObject({ isError: true, body: { code: 'invalid_input' } });
    });
});

describe('规则外操作经 elicitation 询问用户', () => {
    async function connect(
        capabilities: Record<string, unknown>,
        answer?: (message: string) => { action: string; content?: Record<string, unknown> } | Promise<never>,
    ): Promise<{ client: Client; messages: string[] }> {
        await manager.shutdown();
        const config = loadConfig({ AGY_FLEET_DATA_DIR: path.join(root, 'data2') });
        manager = new TaskManager({
            ...config,
            agyBin: process.execPath,
            agyArgs: [mockAgent],
            envAccountHome: path.join(root, 'home'),
            permissions: { ...config.permissions, outsidePolicy: 'ask' },
        });
        manager.init();
        const server = createServer(manager, { askTimeoutMs: 300 });
        const [a, b] = InMemoryTransport.createLinkedPair();
        const asking = new Client({ name: 'test', version: '0' }, { capabilities });
        const messages: string[] = [];
        if (answer !== undefined) {
            asking.setRequestHandler(ElicitRequestSchema, (request) => {
                messages.push(request.params.message);
                return answer(request.params.message);
            });
        }
        await Promise.all([server.connect(a), asking.connect(b)]);
        return { client: asking, messages };
    }

    async function runOutside(c: Client): Promise<any> {
        process.env.MOCK_MODE = 'ok';
        process.env.MOCK_EDIT_PATH = path.join(root, 'outside.txt');
        try {
            const result = await c.callTool({
                name: 'run_task',
                arguments: { prompt: 'x', repo: path.join(root, 'repo') },
            });
            return JSON.parse((result.content as { text: string }[])[0]?.text ?? 'null');
        } finally {
            Reflect.deleteProperty(process.env, 'MOCK_EDIT_PATH');
        }
    }

    it('用户选择允许：编辑放行进 approved；命令被拒进 denied；弹窗里写明操作与原文', async () => {
        const { client: c, messages } = await connect({ elicitation: { form: {} } }, (message) =>
            message.includes('修改文件')
                ? { action: 'accept', content: { decision: 'allow' } }
                : { action: 'accept', content: { decision: 'deny' } },
        );
        const body = await runOutside(c);
        expect(body.final_report).toContain('选择:allow,deny');
        expect(body.approved).toHaveLength(1);
        expect(body.denied).toMatchObject([{ kind: 'execute', target: 'echo hi' }]);
        expect(messages).toHaveLength(2);
        expect(messages[0]).toContain(path.join(root, 'outside.txt'));
        expect(messages[1]).toContain('echo hi');
    });

    it('只声明 elicitation: {} 的旧客户端也能询问；decline / cancel 按拒绝', async () => {
        const { client: c } = await connect({ elicitation: {} }, (message) =>
            message.includes('修改文件') ? { action: 'decline' } : { action: 'cancel' },
        );
        const body = await runOutside(c);
        expect(body.final_report).toContain('选择:deny,deny');
        expect(body.denied).toHaveLength(2);
    });

    it('客户端不支持 elicitation：不发请求，按拒绝并写明原因', async () => {
        const { client: c } = await connect({});
        const body = await runOutside(c);
        expect(body.final_report).toContain('选择:deny,deny');
        expect(body.denied[0].reason).toContain('不支持');
    });

    it('用户迟迟不回应：超时按拒绝', async () => {
        const { client: c } = await connect({ elicitation: { form: {} } }, () => new Promise<never>(() => undefined));
        const body = await runOutside(c);
        expect(body.final_report).toContain('选择:deny,deny');
        expect(body.denied[0].reason).toContain('超时');
    });
});
