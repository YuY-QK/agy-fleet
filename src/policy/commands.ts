// 命令白名单匹配。
//
// agy 的命令请求只给出命令原文（rawInput.CommandLine），由 shell 执行，可能是 `a && b`、管道、子 shell 等组合。
// 所以这里不尝试“理解”shell 语法，而是只接受最朴素的一类命令：若干个词，词之间用空格或制表符分隔，
// 可以用单引号、双引号包住含空格的参数。只要出现任何 shell 控制、展开或通配字符，就判定为“无法安全匹配”，
// 交给 outside_policy 处理。宁可误拒，不可误放。

/**
 * 引号外允许出现的 ASCII 字符（白名单）：字母、数字和 `_ - . / , : @ % + =`。
 * 用白名单而不是黑名单，是因为执行命令的 shell 不确定（bash、zsh 各有自己的特殊字符，如 zsh 的 `^`、`=cmd`）。
 * 非 ASCII 字符（如中文文件名）在常见 shell 里都按字面处理，允许。
 */
const SAFE_UNQUOTED = /^[A-Za-z0-9_\-./,:@%+=]$/;

/** 引号外出现时给出具体原因的字符：控制符、重定向、展开、通配、转义、注释、历史展开。 */
const UNSAFE_UNQUOTED = new Set([
    ';',
    '&',
    '|',
    '<',
    '>',
    '`',
    '$',
    '(',
    ')',
    '{',
    '}',
    '\\',
    '*',
    '?',
    '[',
    ']',
    '~',
    '!',
    '#',
]);

/** 双引号内仍会被 shell 处理的字符。 */
const UNSAFE_IN_DOUBLE = new Set(['$', '`', '\\', '!']);

export type SplitResult = { ok: true; words: string[] } | { ok: false; reason: string };

/**
 * 把命令拆成词。遇到不安全的写法返回原因而不是词表。
 * 第一个词含 `=` 也算不安全，挡住 `VAR=1 cmd` 这种前置环境变量（如 `PATH=…`、`GIT_DIR=…` 会改变命令的行为）。
 */
export function splitCommand(command: string): SplitResult {
    const words: string[] = [];
    let current = '';
    let inWord = false;
    let quote: "'" | '"' | undefined;
    for (const ch of command) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === '\n' || ch === '\r' || (code < 0x20 && ch !== '\t') || code === 0x7f) {
            return { ok: false, reason: '命令含换行或控制字符' };
        }
        if (quote === "'") {
            if (ch === "'") quote = undefined;
            else current += ch;
            continue;
        }
        if (quote === '"') {
            if (ch === '"') quote = undefined;
            else if (UNSAFE_IN_DOUBLE.has(ch)) return { ok: false, reason: `命令在双引号内含 “${ch}”` };
            else current += ch;
            continue;
        }
        if (ch === ' ' || ch === '\t') {
            if (inWord) {
                words.push(current);
                current = '';
                inWord = false;
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            inWord = true;
            continue;
        }
        if (UNSAFE_UNQUOTED.has(ch)) return { ok: false, reason: `命令含 shell 特殊字符 “${ch}”` };
        if (code < 0x80 && !SAFE_UNQUOTED.test(ch)) return { ok: false, reason: `命令含 shell 特殊字符 “${ch}”` };
        // zsh 会把以 = 开头的词展开为命令路径（=ls → /bin/ls）。
        if (ch === '=' && !inWord) return { ok: false, reason: '命令里有以 “=” 开头的词' };
        current += ch;
        inWord = true;
    }
    if (quote !== undefined) return { ok: false, reason: '命令的引号没有闭合' };
    if (inWord) words.push(current);
    if (words.length === 0) return { ok: false, reason: '命令为空' };
    if (words[0]?.includes('=') === true) return { ok: false, reason: '命令以变量赋值开头' };
    return { ok: true, words };
}

/** 一条白名单条目：词表，以及是否允许在其后追加参数（条目末尾写 ` *`）。 */
export interface CommandRule {
    source: string;
    words: string[];
    allowExtraArgs: boolean;
}

/** 解析白名单条目；写法不对时抛错（由配置加载报告给使用者）。 */
export function parseCommandRule(entry: string): CommandRule {
    const trimmed = entry.trim();
    const allowExtraArgs = trimmed.endsWith(' *') || trimmed.endsWith('\t*');
    const body = allowExtraArgs ? trimmed.slice(0, -1).trimEnd() : trimmed;
    const split = splitCommand(body);
    if (!split.ok) throw new Error(`命令白名单条目“${entry}”写法不对：${split.reason}`);
    return { source: entry, words: split.words, allowExtraArgs };
}

/** 命令是否命中某条白名单。返回命中的条目，或不命中的原因。 */
export function matchCommand(
    command: string,
    rules: readonly CommandRule[],
): { matched: true; rule: CommandRule } | { matched: false; reason: string } {
    const split = splitCommand(command);
    if (!split.ok) return { matched: false, reason: split.reason };
    const words = split.words;
    for (const rule of rules) {
        if (rule.allowExtraArgs ? words.length < rule.words.length : words.length !== rule.words.length) continue;
        if (rule.words.every((w, i) => words[i] === w)) return { matched: true, rule };
    }
    return { matched: false, reason: rules.length === 0 ? '命令白名单为空' : '不在命令白名单内' };
}

/**
 * 启动器 / 解释器：它们的参数本身就能指定要执行的代码（如 `git -c alias.x=!cmd x`、`find -exec`、`node -e`、
 * `env cmd`、`xargs cmd`、`ssh host cmd`）。这类命令的 `*` 条目等于允许任意代码执行。
 */
const LAUNCHERS = new Set([
    'git',
    'find',
    'node',
    'nodejs',
    'npm',
    'npx',
    'pnpm',
    'pnpx',
    'yarn',
    'bun',
    'bunx',
    'deno',
    'corepack',
    'env',
    'xargs',
    'sh',
    'bash',
    'zsh',
    'dash',
    'ksh',
    'fish',
    'csh',
    'tcsh',
    'ssh',
    'scp',
    'rsync',
    'sudo',
    'doas',
    'su',
    'perl',
    'ruby',
    'php',
    'lua',
    'awk',
    'gawk',
    'sed',
    'make',
    'cmake',
    'cargo',
    'go',
    'java',
    'uv',
    'uvx',
    'pipx',
    'osascript',
    'open',
    'nohup',
    'nice',
    'time',
    'timeout',
    'watch',
    'exec',
    'eval',
    'command',
    'builtin',
    'source',
    'docker',
    'kubectl',
    'vim',
    'vi',
    'nvim',
    'emacs',
    'tar',
]);
/** 带版本号的解释器名，如 python3、python3.12、pip3。 */
const VERSIONED_LAUNCHER = /^(python|pip|ruby|perl|node|php|lua)[0-9.]*$/;

/** 这条规则是否是“启动器 / 解释器 + `*`”：首个词（取文件名）属于上面的清单，且允许追加参数。 */
export function isLauncherWildcard(rule: CommandRule): boolean {
    if (!rule.allowExtraArgs) return false;
    const first = rule.words[0] ?? '';
    const name = first.slice(first.lastIndexOf('/') + 1).toLowerCase();
    return LAUNCHERS.has(name) || VERSIONED_LAUNCHER.test(name);
}
