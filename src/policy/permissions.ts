import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

// 权限判定（M1 基础版）。规则写死、不接受调用方放宽：
//  - 文件修改类（edit / delete / move）：所有路径解析符号链接与 `..` 后都在本任务 worktree 内才允许；
//  - 命令类与其他类别：一律拒绝。
// 选项只回答“允许一次”或“拒绝一次”，不回答“总是允许”。
// 请求字段（locations[].path、rawInput.Path、rawInput.CommandLine）以 docs/acp-验证结论.md §2.1 的实测为准。

/** 被拒绝的操作。agy 被拒后常常空回复就结束，所以必须由我们汇报。 */
export interface DeniedOperation {
    /** ACP 的工具类别：edit / execute / fetch 等；未知时为 other。 */
    kind: string;
    /** 工具名（如 write_file、run_command），未知时用标题。 */
    tool: string;
    /** 路径或命令原文。 */
    target: string;
    reason: string;
}

export type PermissionVerdict = { allow: true } | { allow: false; denied: DeniedOperation };

type ToolCall = RequestPermissionRequest['toolCall'];

const FILE_MUTATION_KINDS = new Set(['edit', 'delete', 'move']);

/**
 * 逐段解析路径：遇到符号链接就换成真实路径，遇到 `..` 就取真实路径的上一级，
 * 所以 `link/../x` 按文件系统的真实语义落在链接目标的旁边，而不是字面上的旁边。
 * 尚不存在的部分按字面处理。悬空链接、环、权限错误等无法确认的情况抛出异常，调用方按拒绝处理。
 */
export function resolveRealPath(input: string, base: string): string {
    const absolute = path.isAbsolute(input) ? input : `${base}${path.sep}${input}`;
    let current: string = path.sep;
    for (const segment of absolute.split(path.sep)) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            current = path.dirname(current);
            continue;
        }
        const next = path.join(current, segment);
        let isLink: boolean;
        try {
            isLink = lstatSync(next).isSymbolicLink();
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                current = next;
                continue;
            }
            throw err;
        }
        current = isLink ? realpathSync(next) : next;
    }
    return current;
}

/** 从工具调用里取出涉及的路径：locations[].path 与 rawInput.Path，去重。 */
export function extractPaths(toolCall: ToolCall): string[] {
    const found = new Set<string>();
    for (const location of toolCall.locations ?? []) found.add(location.path);
    const raw = toolCall.rawInput;
    if (typeof raw === 'object' && raw !== null) {
        const p = (raw as Record<string, unknown>).Path;
        if (typeof p === 'string' && p !== '') found.add(p);
    }
    return [...found];
}

function commandOf(toolCall: ToolCall): string | undefined {
    const raw = toolCall.rawInput;
    if (typeof raw === 'object' && raw !== null) {
        const c = (raw as Record<string, unknown>).CommandLine;
        if (typeof c === 'string') return c;
    }
    return undefined;
}

function checkInside(candidate: string, worktree: string, base: string): string | undefined {
    let real: string;
    try {
        real = resolveRealPath(candidate, base);
    } catch (err) {
        return `无法解析路径 ${candidate}：${err instanceof Error ? err.message : String(err)}`;
    }
    const relative = path.relative(worktree, real);
    if (relative === '') return `${candidate} 指向 worktree 根目录本身`;
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return `${candidate} 解析后为 ${real}，不在本任务 worktree 内`;
    }
    if (relative.split(path.sep)[0] === '.git') return `${candidate} 位于 .git 内`;
    return undefined;
}

/**
 * 判定一次权限请求。`worktree` 必须是 worktree 的真实路径（已解析符号链接）。
 * 纯判定：只读文件系统元数据，不写任何东西。
 */
export function judgePermission(toolCall: ToolCall, worktree: string): PermissionVerdict {
    const kind = toolCall.kind ?? 'other';
    const tool = toolCall.name ?? toolCall.title ?? kind;
    const deny = (target: string, reason: string): PermissionVerdict => ({
        allow: false,
        denied: { kind, tool, target, reason },
    });

    if (FILE_MUTATION_KINDS.has(kind)) {
        const paths = extractPaths(toolCall);
        if (paths.length === 0) return deny(toolCall.title ?? tool, '请求里没有路径，无法确认在 worktree 内');
        for (const candidate of paths) {
            const problem = checkInside(candidate, worktree, worktree);
            if (problem !== undefined) return deny(candidate, problem);
        }
        return { allow: true };
    }
    if (kind === 'execute') {
        return deny(commandOf(toolCall) ?? toolCall.title ?? tool, 'M1 不允许执行命令');
    }
    return deny(toolCall.title ?? tool, `M1 不允许“${kind}”类操作`);
}

/** 把判定变成给 agy 的应答：只选 allow_once / reject_once；找不到对应选项时取消。 */
export function toPermissionResponse(
    request: RequestPermissionRequest,
    verdict: PermissionVerdict,
): RequestPermissionResponse {
    const wanted = verdict.allow ? 'allow_once' : 'reject_once';
    const option = request.options.find((o) => o.kind === wanted);
    if (option === undefined) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
}
