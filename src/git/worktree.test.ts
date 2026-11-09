import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree, diffStat, parseNumstat, removeWorktree } from './worktree.ts';

let root: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-wt-')));
    repo = path.join(root, 'repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('worktree', () => {
    it('建 worktree、统计改动（含新文件）、删除', async () => {
        const wt = await createWorktree({ repo, taskId: 't-test', worktreeRoot: path.join(root, 'wts') });
        expect(wt.branch).toBe('agy-fleet/t-test');
        expect(git(wt.path, 'branch', '--show-current').trim()).toBe('agy-fleet/t-test');

        expect(await diffStat(wt)).toMatchObject({ totalFiles: 0, added: 0, deleted: 0 });

        writeFileSync(path.join(wt.path, 'a.txt'), 'one\nTWO\nthree\n');
        writeFileSync(path.join(wt.path, 'new.txt'), 'x\ny\n');
        const stat = await diffStat(wt);
        expect(stat.totalFiles).toBe(2);
        expect(stat.files).toContainEqual({ path: 'new.txt', added: 2, deleted: 0 });
        expect(stat.files).toContainEqual({ path: 'a.txt', added: 2, deleted: 1 });

        await removeWorktree(wt, true);
        expect(git(repo, 'branch', '--list', 'agy-fleet/*').trim()).toBe('');
    });

    it('非 git 目录报 worktree_failed', async () => {
        await expect(
            createWorktree({ repo: root, taskId: 't-x', worktreeRoot: path.join(root, 'wts') }),
        ).rejects.toMatchObject({
            code: 'worktree_failed',
        });
    });
});

describe('parseNumstat', () => {
    it('处理二进制与改名', () => {
        const out = '-\t-\timg.png\0' + '1\t0\t\0old.txt\0new.txt\0';
        expect(parseNumstat(out).files).toEqual([
            { path: 'img.png', added: 0, deleted: 0 },
            { path: 'new.txt', added: 1, deleted: 0 },
        ]);
    });
});
