import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { FleetError } from '../errors.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        const e = err as { stderr?: string; message: string };
        throw new FleetError('worktree_failed', `git ${args.join(' ')} 失败：${(e.stderr ?? e.message).trim()}`);
    }
}

export interface Worktree {
    /** worktree 的真实路径（已解析符号链接）。 */
    path: string;
    branch: string;
    /** 创建时的基准提交。 */
    baseCommit: string;
    /** 源仓库根目录。 */
    repoRoot: string;
}

export interface DiffFile {
    path: string;
    added: number;
    deleted: number;
}

export interface DiffStat {
    files: DiffFile[];
    totalFiles: number;
    added: number;
    deleted: number;
}

/** 在 `worktreeRoot` 下为任务建 worktree 与分支 `agy-fleet/<taskId>`，基于 `base`（默认当前 HEAD）。 */
export async function createWorktree(options: {
    repo: string;
    taskId: string;
    worktreeRoot: string;
    base?: string;
}): Promise<Worktree> {
    const repoRoot = realpathSync((await git(options.repo, ['rev-parse', '--show-toplevel'])).trim());
    const baseCommit = (await git(repoRoot, ['rev-parse', '--verify', `${options.base ?? 'HEAD'}^{commit}`])).trim();
    const branch = `agy-fleet/${options.taskId}`;
    mkdirSync(options.worktreeRoot, { recursive: true });
    const wtPath = path.join(realpathSync(options.worktreeRoot), `${path.basename(repoRoot)}-${options.taskId}`);
    await git(repoRoot, ['worktree', 'add', '-b', branch, wtPath, baseCommit]);
    return { path: realpathSync(wtPath), branch, baseCommit, repoRoot };
}

/** 删除 worktree；`deleteBranch` 为真时一并删分支。目录或分支已不存在时视为已完成。 */
export async function removeWorktree(wt: Worktree, deleteBranch: boolean): Promise<void> {
    if (existsSync(wt.path)) {
        await git(wt.repoRoot, ['worktree', 'remove', '--force', wt.path]);
    } else {
        await git(wt.repoRoot, ['worktree', 'prune']);
    }
    if (deleteBranch && (await branchExists(wt))) await git(wt.repoRoot, ['branch', '-D', wt.branch]);
}

async function branchExists(wt: Worktree): Promise<boolean> {
    try {
        await git(wt.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]);
        return true;
    } catch {
        return false;
    }
}

/**
 * 相对基准提交的改动统计，含新建的未跟踪文件。
 * 用 `add -N`（intent-to-add）让新文件进入 diff；只动这个 worktree 自己的索引，不暂存内容。
 */
export async function diffStat(wt: Worktree): Promise<DiffStat> {
    await git(wt.path, ['add', '-A', '-N']);
    const out = await git(wt.path, ['diff', '--numstat', '-z', wt.baseCommit]);
    return parseNumstat(out);
}

/** 解析 `git diff --numstat -z`：普通项为 `added\tdeleted\tpath\0`，改名项为 `added\tdeleted\t\0old\0new\0`。 */
export function parseNumstat(out: string): DiffStat {
    const parts = out.split('\0');
    const files: DiffFile[] = [];
    let i = 0;
    while (i < parts.length) {
        const head = parts[i++];
        if (!head) continue;
        const [a, d, p] = head.split('\t');
        let filePath = p ?? '';
        if (filePath === '') {
            i++; // 旧路径
            filePath = parts[i++] ?? '';
        }
        // 二进制文件的增删行数是 "-"。
        files.push({ path: filePath, added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d) });
    }
    return {
        files,
        totalFiles: files.length,
        added: files.reduce((n, f) => n + f.added, 0),
        deleted: files.reduce((n, f) => n + f.deleted, 0),
    };
}
