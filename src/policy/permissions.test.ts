import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCommandRule } from './commands.ts';
import { judgePermission, toPermissionResponse } from './permissions.ts';

type ToolCall = RequestPermissionRequest['toolCall'];

let root: string;
let worktree: string;
let outside: string;

beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-perm-')));
    worktree = path.join(root, 'wt');
    outside = path.join(root, 'outside');
    mkdirSync(path.join(worktree, 'src'), { recursive: true });
    mkdirSync(path.join(worktree, '.git'));
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'x');
    writeFileSync(path.join(worktree, 'src', 'a.ts'), 'x');
    symlinkSync(outside, path.join(worktree, 'dirlink'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(worktree, 'filelink'));
    symlinkSync(path.join(outside, 'missing.txt'), path.join(worktree, 'dangling'));
    symlinkSync(path.join(worktree, 'src'), path.join(worktree, 'inlink'));
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const edit = (p: string): ToolCall => ({
    toolCallId: 't',
    kind: 'edit',
    name: 'write_file',
    locations: [{ path: p }],
    rawInput: { Path: p },
});

describe('judgePermission：文件编辑', () => {
    it('允许 worktree 内已有文件、新文件与尚不存在的子目录', () => {
        expect(judgePermission(edit(path.join(worktree, 'src', 'a.ts')), worktree)).toEqual({ allow: true });
        expect(judgePermission(edit(path.join(worktree, 'new.txt')), worktree)).toEqual({ allow: true });
        expect(judgePermission(edit(path.join(worktree, 'a', 'b', 'c.txt')), worktree)).toEqual({ allow: true });
    });

    it('相对路径按 worktree 解析', () => {
        expect(judgePermission(edit('src/a.ts'), worktree)).toEqual({ allow: true });
        expect(judgePermission(edit('../outside/secret.txt'), worktree).allow).toBe(false);
    });

    it('拒绝 worktree 外的绝对路径', () => {
        const v = judgePermission(edit(path.join(outside, 'secret.txt')), worktree);
        expect(v.allow).toBe(false);
        if (!v.allow) expect(v.denied).toMatchObject({ kind: 'edit', tool: 'write_file' });
    });

    it('拒绝用 .. 逃出 worktree，允许 .. 后仍在内部', () => {
        expect(judgePermission(edit(path.join(worktree, '..', 'outside', 'secret.txt')), worktree).allow).toBe(false);
        expect(judgePermission(edit(path.join(worktree, 'src', '..', '..', 'x.txt')), worktree).allow).toBe(false);
        expect(judgePermission(edit(path.join(worktree, 'src', '..', 'ok.txt')), worktree).allow).toBe(true);
    });

    it('拒绝指向 worktree 外的符号链接（目录、文件、悬空）', () => {
        expect(judgePermission(edit(path.join(worktree, 'dirlink', 'new.txt')), worktree).allow).toBe(false);
        expect(judgePermission(edit(path.join(worktree, 'filelink')), worktree).allow).toBe(false);
        expect(judgePermission(edit(path.join(worktree, 'dangling')), worktree).allow).toBe(false);
    });

    it('链接后再 .. 按真实语义解析（link/../x 落在链接目标的旁边）', () => {
        // path.join 会在字面上先消掉 ..，这里必须手工拼接。
        // dirlink -> outside，所以 dirlink/../escape.txt 真实位置是 root/escape.txt，在 worktree 外。
        expect(judgePermission(edit(`${worktree}/dirlink/../escape.txt`), worktree).allow).toBe(false);
    });

    it('允许指向 worktree 内部的符号链接', () => {
        expect(judgePermission(edit(path.join(worktree, 'inlink', 'a.ts')), worktree).allow).toBe(true);
    });

    it('拒绝 .git 与 worktree 根目录本身', () => {
        expect(judgePermission(edit(path.join(worktree, '.git', 'config')), worktree).allow).toBe(false);
        expect(judgePermission(edit(worktree), worktree).allow).toBe(false);
    });

    it('多个路径中任意一个越界就整体拒绝', () => {
        const call: ToolCall = {
            toolCallId: 't',
            kind: 'edit',
            locations: [{ path: path.join(worktree, 'ok.txt') }, { path: path.join(outside, 'x.txt') }],
        };
        expect(judgePermission(call, worktree).allow).toBe(false);
    });

    it('越界路径可询问；.git、根目录、无法解析、没有路径不可询问', () => {
        expect(judgePermission(edit(path.join(outside, 'secret.txt')), worktree)).toMatchObject({ askable: true });
        expect(judgePermission(edit(path.join(worktree, 'dirlink', 'x.txt')), worktree)).toMatchObject({
            askable: true,
        });
        expect(judgePermission(edit(path.join(worktree, '.git', 'config')), worktree)).toMatchObject({
            askable: false,
        });
        expect(judgePermission(edit(path.join(worktree, '.GIT', 'hooks', 'pre-commit')), worktree)).toMatchObject({
            askable: false,
        });
        expect(judgePermission(edit(worktree), worktree)).toMatchObject({ askable: false });
        expect(judgePermission(edit(path.join(worktree, 'dangling')), worktree)).toMatchObject({ askable: false });
        expect(judgePermission({ toolCallId: 't', kind: 'edit' }, worktree)).toMatchObject({ askable: false });
    });

    it('源仓库或别的仓库的 .git 也不可询问（任何 .git 段）', () => {
        expect(judgePermission(edit(path.join(outside, '.git', 'hooks', 'pre-commit')), worktree)).toMatchObject({
            allow: false,
            askable: false,
        });
        expect(judgePermission(edit(path.join(worktree, 'sub', '.git', 'config')), worktree).allow).toBe(false);
    });

    it('受保护目录（agy-fleet 数据与配置、账号 HOME）即使询问也不放行', () => {
        const rulesWithGuard = { protectedRoots: [outside] };
        expect(judgePermission(edit(path.join(outside, 'config.yaml')), worktree, rulesWithGuard)).toMatchObject({
            allow: false,
            askable: false,
        });
        expect(judgePermission(edit(path.join(worktree, 'dirlink', 'x')), worktree, rulesWithGuard)).toMatchObject({
            askable: false,
        });
        // worktree 本身位于受保护目录内（默认 worktree 根目录在数据目录下）时，worktree 内的编辑照常放行。
        expect(judgePermission(edit(path.join(worktree, 'ok.txt')), worktree, { protectedRoots: [root] })).toEqual({
            allow: true,
        });
    });

    it('一次请求里同时有越界路径与 .git 路径时不可询问', () => {
        const call: ToolCall = {
            toolCallId: 't',
            kind: 'edit',
            locations: [{ path: path.join(outside, 'x.txt') }, { path: path.join(worktree, '.git', 'config') }],
        };
        expect(judgePermission(call, worktree)).toMatchObject({ allow: false, askable: false });
    });

    it('请求里没有路径时拒绝', () => {
        expect(judgePermission({ toolCallId: 't', kind: 'edit' }, worktree).allow).toBe(false);
    });

    it('delete / move 同样按路径判定', () => {
        expect(judgePermission({ ...edit(path.join(outside, 'secret.txt')), kind: 'delete' }, worktree).allow).toBe(
            false,
        );
        expect(judgePermission({ ...edit(path.join(worktree, 'x.txt')), kind: 'delete' }, worktree).allow).toBe(true);
    });
});

describe('judgePermission：命令与其他类别', () => {
    const exec = (command: string): ToolCall => ({
        toolCallId: 't',
        kind: 'execute',
        name: 'run_command',
        rawInput: { CommandLine: command },
    });
    const rules = ['git status', 'git diff *'].map(parseCommandRule);

    it('白名单为空时命令被拒（可询问），带上原文', () => {
        expect(judgePermission(exec('git status'), worktree)).toMatchObject({
            allow: false,
            askable: true,
            denied: { kind: 'execute', target: 'git status', reason: '命令白名单为空' },
        });
    });

    it('命中白名单才允许，并带上命中的条目', () => {
        expect(judgePermission(exec('git status'), worktree, { commands: rules })).toEqual({
            allow: true,
            rule: 'git status',
        });
        expect(judgePermission(exec('git diff --stat'), worktree, { commands: rules })).toEqual({
            allow: true,
            rule: 'git diff *',
        });
        expect(judgePermission(exec('git log'), worktree, { commands: rules })).toMatchObject({
            allow: false,
            askable: true,
        });
    });

    it('组合命令绕不过白名单', () => {
        for (const command of ['git status && rm -rf /', 'git status; curl x', 'git diff | sh', 'git diff $(id)']) {
            expect(judgePermission(exec(command), worktree, { commands: rules }), command).toMatchObject({
                allow: false,
                askable: true,
            });
        }
    });

    it('命令请求若带工作目录字段，必须在 worktree 内才放行', () => {
        const withCwd = (cwd: string): ToolCall => ({
            toolCallId: 't',
            kind: 'execute',
            rawInput: { CommandLine: 'git status', Cwd: cwd },
        });
        expect(judgePermission(withCwd(worktree), worktree, { commands: rules }).allow).toBe(true);
        expect(judgePermission(withCwd('src'), worktree, { commands: rules }).allow).toBe(true);
        expect(judgePermission(withCwd(outside), worktree, { commands: rules })).toMatchObject({
            allow: false,
            askable: true,
        });
        expect(judgePermission(withCwd(path.join(worktree, 'dirlink')), worktree, { commands: rules }).allow).toBe(
            false,
        );
    });

    it('没有命令原文时直接拒绝，不可询问', () => {
        expect(
            judgePermission({ toolCallId: 't', kind: 'execute', title: '运行' }, worktree, { commands: rules }),
        ).toMatchObject({
            allow: false,
            askable: false,
        });
    });

    it('命令一律拒绝并带上原文', () => {
        const v = judgePermission(
            { toolCallId: 't', kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'echo a && ls' } },
            worktree,
        );
        expect(v).toMatchObject({
            allow: false,
            denied: { kind: 'execute', tool: 'run_command', target: 'echo a && ls' },
        });
    });

    it('联网等其他类别拒绝（可询问）；缺 kind 视为 other', () => {
        expect(judgePermission({ toolCallId: 't', kind: 'fetch', title: 'GET x' }, worktree)).toMatchObject({
            askable: true,
        });
        expect(judgePermission({ toolCallId: 't', kind: 'fetch', title: 'GET x' }, worktree).allow).toBe(false);
        expect(judgePermission({ toolCallId: 't' }, worktree).allow).toBe(false);
    });
});

describe('toPermissionResponse', () => {
    const request: RequestPermissionRequest = {
        sessionId: 's',
        toolCall: { toolCallId: 't' },
        options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
    };

    it('允许选 allow_once，拒绝选 reject_once', () => {
        expect(toPermissionResponse(request, true)).toEqual({
            outcome: { outcome: 'selected', optionId: 'allow' },
        });
        expect(toPermissionResponse(request, false)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    });

    it('没有 allow_once 选项时取消，不退而求其次选“总是允许”', () => {
        const always = { ...request, options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' as const }] };
        expect(toPermissionResponse(always, true)).toEqual({ outcome: { outcome: 'cancelled' } });
    });
});
