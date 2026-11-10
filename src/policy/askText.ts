import type { DeniedOperation } from './permissions.ts';

// 询问弹窗的文本。命令与路径原文来自工作进程，可能被精心构造：带换行伪造“原因”行、用 ANSI 转义或
// 双向控制字符改变显示、或用超长文本把关键部分挤出视野。所以：
//  - 换行、控制字符、格式字符一律转义成可见形式（\n、\x1b、\u{202e}），反斜杠本身写成 \\；
//  - 原文放在等宽代码块里，围栏比原文里最长的反引号串更长，原文无法提前闭合代码块；
//  - 显示原文长度；超过展示上限时不弹窗（由调用方按拒绝处理），绝不截断后让用户确认看不全的内容。

/** 目标原文（命令或路径）的展示上限，按字符数。 */
export const MAX_TARGET_CHARS = 1500;
/** 原因文本（含解析后的路径）的展示上限。 */
export const MAX_REASON_CHARS = 4000;

const KIND_TEXT: Record<string, string> = {
    edit: '修改文件',
    delete: '删除文件',
    move: '移动文件',
    execute: '执行命令',
};

/** 按 Unicode 码点计数（与弹窗里看到的字符数一致，不按 UTF-16 单元）。 */
function charCount(text: string): number {
    return Array.from(text).length;
}

/** 把看不见或会改变显示的字符转成可见的转义形式。 */
export function escapeVisible(text: string): string {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === '\\') out += '\\\\';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\x${code.toString(16).padStart(2, '0')}`;
        else if (/[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u.test(ch)) out += `\\u{${code.toString(16)}}`;
        else out += ch;
    }
    return out;
}

/** 放进代码块：围栏的反引号比内容里最长的连续反引号多一个（至少 3 个）。 */
function codeBlock(text: string): string {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}\n${text}\n${fence}`;
}

export type AskText = { ok: true; message: string } | { ok: false; reason: string };

/** 这次操作能否完整展示给用户；不能时返回原因（调用方应直接拒绝，不弹窗）。 */
export function askBlocker(operation: DeniedOperation): string | undefined {
    const targetChars = charCount(operation.target);
    if (targetChars > MAX_TARGET_CHARS) {
        return `原文过长（${String(targetChars)} 字符，上限 ${String(MAX_TARGET_CHARS)}），无法完整展示`;
    }
    const reasonChars = charCount(operation.reason);
    if (reasonChars > MAX_REASON_CHARS) return `原因文本过长（${String(reasonChars)} 字符），无法完整展示`;
    return undefined;
}

/** 生成弹窗文本；无法完整展示时返回原因。 */
export function formatAskMessage(question: { taskId: string; account: string; operation: DeniedOperation }): AskText {
    const { operation } = question;
    const target = operation.target;
    const blocker = askBlocker(operation);
    if (blocker !== undefined) return { ok: false, reason: blocker };
    const what = KIND_TEXT[operation.kind] ?? `“${escapeVisible(operation.kind)}”类操作`;
    const message = [
        `agy-fleet：任务 ${escapeVisible(question.taskId)}（账号 ${escapeVisible(question.account)}）请求${what}，超出权限规则。`,
        '',
        `原文（${String(charCount(target))} 字符；换行与控制字符已转义显示）：`,
        codeBlock(escapeVisible(target)),
        '',
        '原因：',
        codeBlock(escapeVisible(operation.reason)),
        '',
        '只允许这一次吗？不回应或取消都按拒绝处理。',
    ].join('\n');
    return { ok: true, message };
}
