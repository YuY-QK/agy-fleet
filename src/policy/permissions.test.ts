import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCommandRule } from './commands.ts';
import { extractPaths, judgePermission, sensitiveUserRoots, toPermissionResponse } from './permissions.ts';

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

describe('judgePermission：rawInput 里的其他路径键', () => {
    const inside = (): string => path.join(worktree, 'ok.txt');
    const call = (rawInput: Record<string, unknown>, locations: string[] = []): ToolCall => ({
        toolCallId: 't',
        kind: 'edit',
        name: 'replace_file_content',
        locations: locations.map((p) => ({ path: p })),
        rawInput,
    });

    it('locations 在内、TargetFile 在外：拒绝（可询问）', () => {
        expect(judgePermission(call({ TargetFile: path.join(outside, 'x.txt') }, [inside()]), worktree)).toMatchObject({
            allow: false,
            askable: true,
            denied: { target: path.join(outside, 'x.txt') },
        });
    });

    it('locations 为空、TargetFile 在外：拒绝', () => {
        expect(judgePermission(call({ TargetFile: path.join(outside, 'x.txt') }), worktree).allow).toBe(false);
    });

    it.each([
        'Destination',
        'DestinationPath',
        'AbsolutePath',
        'FilePath',
        'SourcePath',
        'DirectoryPath',
        'targetfile',
    ])('%s 在外：拒绝', (key) => {
        expect(judgePermission(call({ Path: inside(), [key]: path.join(outside, 'x') }), worktree).allow).toBe(false);
    });

    it('键名含 path/file/dir/target/destination/source 的未知键也检查', () => {
        for (const key of ['NewFilePath', 'OutputDir', 'MoveTarget', 'SourceFiles', 'backupPathName']) {
            expect(judgePermission(call({ Path: inside(), [key]: path.join(outside, 'x') }), worktree).allow, key).toBe(
                false,
            );
        }
    });

    it('像路径的键下的字符串数组逐项检查', () => {
        expect(judgePermission(call({ FilePaths: [inside(), path.join(outside, 'x')] }), worktree).allow).toBe(false);
        expect(judgePermission(call({ FilePaths: [inside(), path.join(worktree, 'b.txt')] }), worktree).allow).toBe(
            true,
        );
    });

    it('全部在内时放行；Destination 指向 .git 时直接拒绝', () => {
        expect(
            judgePermission(
                call({ SourcePath: inside(), Destination: path.join(worktree, 'moved.txt') }, [inside()]),
                worktree,
            ),
        ).toEqual({ allow: true });
        expect(
            judgePermission(call({ SourcePath: inside(), Destination: path.join(worktree, '.git', 'x') }), worktree),
        ).toMatchObject({ allow: false, askable: false });
    });

    it('只展开第一层：像路径的键下是对象、或数组里有对象时直接拒绝（不可询问）', () => {
        expect(
            judgePermission(call({ Path: inside(), Target: { file: path.join(outside, 'x') } }), worktree),
        ).toMatchObject({
            allow: false,
            askable: false,
        });
        expect(judgePermission(call({ Files: [inside(), { p: 'x' }] }), worktree)).toMatchObject({
            allow: false,
            askable: false,
        });
    });

    it('不像路径的键与文件内容不当作路径', () => {
        const v = judgePermission(
            call({
                Path: inside(),
                TargetContent: `import x from '../../../../../etc/passwd';`,
                ReplacementContent: '/etc/passwd',
                Instruction: '/etc/passwd',
                IsDirectory: true,
                Options: { anything: '/etc/passwd' },
            }),
            worktree,
        );
        expect(v).toEqual({ allow: true });
    });

    it('extractPaths 去重并合并 locations 与 rawInput', () => {
        expect(extractPaths(call({ Path: inside(), TargetFile: inside() }, [inside()]))).toEqual({
            paths: [inside()],
            unverifiable: [],
        });
    });
});

describe('judgePermission：用户 HOME 下的敏感位置', () => {
    let userHome: string;
    let accountHome: string;

    beforeAll(() => {
        userHome = path.join(root, 'user');
        accountHome = path.join(root, 'acct');
        mkdirSync(path.join(userHome, '.ssh'), { recursive: true });
        mkdirSync(path.join(userHome, 'Library', 'LaunchAgents'), { recursive: true });
        mkdirSync(accountHome);
        writeFileSync(path.join(userHome, '.gitconfig'), '[user]\n');
        symlinkSync(path.join(userHome, '.gitconfig'), path.join(accountHome, '.gitconfig'));
        symlinkSync(userHome, path.join(root, 'user-link'));
    });

    const rulesFor = (): { protectedRoots: string[] } => ({ protectedRoots: sensitiveUserRoots(userHome) });

    it.each([
        '.gitconfig',
        '.config/git/config',
        '.ssh/authorized_keys',
        '.zshrc',
        '.zprofile',
        '.zshenv',
        '.bashrc',
        '.bash_profile',
        '.profile',
        '.npmrc',
        '.aws/credentials',
        '.gnupg/gpg.conf',
        'Library/LaunchAgents/x.plist',
        '.config/gh/hosts.yml',
    ])('直接路径 ~/%s：直接拒绝，不可询问', (relative) => {
        expect(judgePermission(edit(path.join(userHome, ...relative.split('/'))), worktree, rulesFor())).toMatchObject({
            allow: false,
            askable: false,
        });
    });

    it('账号 HOME 里指向 ~/.gitconfig 的符号链接：直接拒绝', () => {
        expect(judgePermission(edit(path.join(accountHome, '.gitconfig')), worktree, rulesFor())).toMatchObject({
            allow: false,
            askable: false,
        });
    });

    it('经由指向用户 HOME 的符号链接、或大小写不同：直接拒绝', () => {
        expect(judgePermission(edit(path.join(root, 'user-link', '.zshrc')), worktree, rulesFor())).toMatchObject({
            askable: false,
        });
        expect(judgePermission(edit(path.join(userHome, '.GitConfig')), worktree, rulesFor())).toMatchObject({
            askable: false,
        });
    });

    it('用户 HOME 下的其他文件仍是“越界、可询问”', () => {
        expect(judgePermission(edit(path.join(userHome, 'notes.txt')), worktree, rulesFor())).toMatchObject({
            allow: false,
            askable: true,
        });
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
