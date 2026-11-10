import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { matchCommand, type CommandRule } from './commands.ts';

// 权限判定。规则只来自代码与配置文件，不接受 MCP 工具参数放宽（PLAN §6.5）：
//  - 文件修改类（edit / delete / move）：所有路径解析符号链接与 `..` 后都在本任务 worktree 内才允许；
//  - 命令类：命中命令白名单（见 commands.ts）才允许；
//  - 其他类别：不允许。
// 不允许的操作分两种：可以交给 outside_policy（拒绝或询问用户）的“规则外”操作，
// 和无论如何都直接拒绝的操作：路径里有 .git 段、落在受保护目录（agy-fleet 的数据与配置、账号 HOME，
// 改它们等于让工作进程给自己提权）、路径无法解析、请求里没有路径或命令原文。
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

/** 规则外、经用户在客户端确认后放行的操作。 */
export interface ApprovedOperation {
    kind: string;
    tool: string;
    target: string;
    note: string;
}

export type PermissionVerdict =
    | { allow: true; rule?: string }
    /** `askable`：是否可以按 outside_policy 询问用户；为 false 时必须直接拒绝。 */
    | { allow: false; askable: boolean; denied: DeniedOperation };

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

/** agy 工具参数里已知的路径键（小写比较）。 */
const KNOWN_PATH_KEYS = new Set([
    'path',
    'targetfile',
    'absolutepath',
    'filepath',
    'sourcepath',
    'destination',
    'destinationpath',
    'directorypath',
]);
/** 键名含这些词的字符串参数也当作路径（宁多勿少）。 */
const PATH_LIKE_KEY = /path|file|dir|target|destination|source/i;
/**
 * 例外：键名含 content 的是文件内容（如 TargetContent、ReplacementContent），不是路径；
 * 把代码文本当路径解析，遇到 `../` 之类会把正常编辑误判为越界。已知路径键不受此例外影响。
 */
const CONTENT_KEY = /content/i;

function isPathKey(key: string): boolean {
    const lower = key.toLowerCase();
    return KNOWN_PATH_KEYS.has(lower) || (PATH_LIKE_KEY.test(key) && !CONTENT_KEY.test(key));
}

/** 从请求里取出的路径。`unverifiable` 是像路径的键但值无法检查（嵌套对象等），必须直接拒绝。 */
export interface ExtractedPaths {
    paths: string[];
    unverifiable: string[];
}

/**
 * 从工具调用里取出涉及的路径：`locations[].path`，加上 `rawInput` 第一层所有像路径的键的字符串值
 * （以及这些键下字符串数组的元素），去重。只看第一层：像路径的键下若是对象、或数组里有非字符串元素，
 * 记入 `unverifiable`，由调用方直接拒绝；不像路径的键下的嵌套对象不展开。
 */
export function extractPaths(toolCall: ToolCall): ExtractedPaths {
    const found = new Set<string>();
    const unverifiable: string[] = [];
    for (const location of toolCall.locations ?? []) found.add(location.path);
    const raw = toolCall.rawInput;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (!isPathKey(key)) continue;
            if (typeof value === 'string') {
                if (value !== '') found.add(value);
            } else if (Array.isArray(value)) {
                for (const item of value) {
                    if (typeof item === 'string') {
                        if (item !== '') found.add(item);
                    } else unverifiable.push(key);
                }
            } else if (typeof value === 'object' && value !== null) {
                unverifiable.push(key);
            }
            // 数字、布尔、null（如 IsDirectory: true）不是路径，忽略。
        }
    }
    return { paths: [...found], unverifiable: [...new Set(unverifiable)] };
}

function commandOf(toolCall: ToolCall): string | undefined {
    const raw = toolCall.rawInput;
    if (typeof raw === 'object' && raw !== null) {
        const c = (raw as Record<string, unknown>).CommandLine;
        if (typeof c === 'string') return c;
    }
    return undefined;
}

/**
 * 用户 HOME 下改了就会在用户日常使用时执行代码或泄露凭据的位置（持久化代码执行路径）。
 * 内置、配置无法关闭；无论 outside_policy 都直接拒绝。
 */
export const SENSITIVE_USER_PATHS: readonly string[] = [
    '.gitconfig',
    '.config/git',
    '.ssh',
    '.zshrc',
    '.zprofile',
    '.zshenv',
    '.zlogin',
    '.bashrc',
    '.bash_profile',
    '.bash_login',
    '.profile',
    '.npmrc',
    '.aws',
    '.gnupg',
    'Library/LaunchAgents',
    '.config/gh',
];

/** 用户 HOME 下受保护位置的字面路径与真实路径（HOME 本身是符号链接时两者不同），去重。 */
export function sensitiveUserRoots(userHome: string): string[] {
    const homes = new Set([path.resolve(userHome)]);
    try {
        homes.add(realpathSync(userHome));
    } catch {
        // HOME 不存在时只用字面路径
    }
    const roots = new Set<string>();
    for (const home of homes) {
        for (const relative of SENSITIVE_USER_PATHS) roots.add(path.join(home, ...relative.split('/')));
    }
    return [...roots];
}

/** 适用于一个任务的规则（全部来自配置文件与代码，调用方无法放宽）。 */
export interface PermissionRules {
    /** 命令白名单（全局 + 按仓库）。 */
    commands?: readonly CommandRule[];
    /** worktree 外、即使用户同意也不允许修改的目录或文件（同时给出字面路径与真实路径）。 */
    protectedRoots?: readonly string[];
}

/** 受保护位置按小写比较：macOS 默认文件系统不区分大小写，`~/.GitConfig` 就是 `~/.gitconfig`。宁可多拒。 */
function isWithinIgnoringCase(child: string, parent: string): boolean {
    return isWithin(child.toLowerCase(), parent.toLowerCase());
}

function isWithin(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return (
        relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
}

/** 路径检查的结论：在内（undefined），或问题与是否可询问用户。 */
function checkInside(
    candidate: string,
    worktree: string,
    base: string,
    protectedRoots: readonly string[] = [],
): { reason: string; askable: boolean } | undefined {
    let real: string;
    try {
        real = resolveRealPath(candidate, base);
    } catch (err) {
        return {
            reason: `无法解析路径 ${candidate}：${err instanceof Error ? err.message : String(err)}`,
            askable: false,
        };
    }
    // 任何 .git 段一律拒绝（本 worktree 的 .git 文件、源仓库或别的仓库的 .git 目录都算）；
    // 大小写不敏感的文件系统上 `.GIT` 指向同一目录，所以按小写比较。
    if (real.split(path.sep).some((segment) => segment.toLowerCase() === '.git')) {
        return { reason: `${candidate} 解析后为 ${real}，位于 .git 内`, askable: false };
    }
    const relative = path.relative(worktree, real);
    if (relative === '') return { reason: `${candidate} 指向 worktree 根目录本身`, askable: false };
    if (isWithin(real, worktree)) return undefined;
    const guarded = protectedRoots.find((root) => isWithinIgnoringCase(real, root));
    if (guarded !== undefined) {
        return {
            reason: `${candidate} 解析后为 ${real}，属于受保护的位置 ${guarded}`,
            askable: false,
        };
    }
    return { reason: `${candidate} 解析后为 ${real}，不在本任务 worktree 内`, askable: true };
}

/** 命令请求里像“工作目录”的字段（agy 1.5.3 实测没有；将来若出现，命令可能不在 worktree 里执行）。 */
function directoryFields(toolCall: ToolCall): string[] {
    const raw = toolCall.rawInput;
    if (typeof raw !== 'object' || raw === null) return [];
    return Object.entries(raw as Record<string, unknown>)
        .filter(([key, value]) => key !== 'CommandLine' && /cwd|dir/i.test(key) && typeof value === 'string')
        .map(([, value]) => value as string);
}

/**
 * 判定一次权限请求。`worktree` 必须是 worktree 的真实路径（已解析符号链接）；
 * `rules` 是本任务适用的规则（命令白名单、受保护目录，来自配置文件与代码）。
 * 纯判定：只读文件系统元数据，不写任何东西。
 */
export function judgePermission(toolCall: ToolCall, worktree: string, rules: PermissionRules = {}): PermissionVerdict {
    const commands = rules.commands ?? [];
    const protectedRoots = rules.protectedRoots ?? [];
    const kind = toolCall.kind ?? 'other';
    const tool = toolCall.name ?? toolCall.title ?? kind;
    const deny = (target: string, reason: string, askable: boolean): PermissionVerdict => ({
        allow: false,
        askable,
        denied: { kind, tool, target, reason },
    });

    if (FILE_MUTATION_KINDS.has(kind)) {
        const { paths, unverifiable } = extractPaths(toolCall);
        if (unverifiable.length > 0) {
            return deny(
                `${toolCall.title ?? tool}（${unverifiable.join(', ')}）`,
                `请求参数 ${unverifiable.join(', ')} 的值不是路径字符串，无法确认在 worktree 内`,
                false,
            );
        }
        if (paths.length === 0) return deny(toolCall.title ?? tool, '请求里没有路径，无法确认在 worktree 内', false);
        // 先找必须直接拒绝的路径：一次请求里只要有一个这样的路径，就不能交给用户询问。
        let outside: { candidate: string; reason: string } | undefined;
        for (const candidate of paths) {
            const problem = checkInside(candidate, worktree, worktree, protectedRoots);
            if (problem === undefined) continue;
            if (!problem.askable) return deny(candidate, problem.reason, false);
            outside ??= { candidate, reason: problem.reason };
        }
        if (outside !== undefined) return deny(outside.candidate, outside.reason, true);
        return { allow: true };
    }
    if (kind === 'execute') {
        const command = commandOf(toolCall);
        if (command === undefined) return deny(toolCall.title ?? tool, '请求里没有命令原文，无法匹配白名单', false);
        const match = matchCommand(command, commands);
        if (match.matched) {
            for (const dir of directoryFields(toolCall)) {
                let real: string;
                try {
                    real = resolveRealPath(dir, worktree);
                } catch {
                    return deny(command, `命令的工作目录 ${dir} 无法解析`, false);
                }
                if (!isWithin(real, worktree)) {
                    return deny(command, `命令在白名单内，但工作目录 ${real} 不在本任务 worktree 内`, true);
                }
            }
            return { allow: true, rule: match.rule.source };
        }
        return deny(command, match.reason, true);
    }
    return deny(toolCall.title ?? tool, `不允许“${kind}”类操作`, true);
}

/** 把最终决定变成给 agy 的应答：只选 allow_once / reject_once；找不到对应选项时取消。 */
export function toPermissionResponse(request: RequestPermissionRequest, allow: boolean): RequestPermissionResponse {
    const wanted = allow ? 'allow_once' : 'reject_once';
    const option = request.options.find((o) => o.kind === wanted);
    if (option === undefined) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
}
