import { describe, expect, it } from 'vitest';
import { askBlocker, escapeVisible, formatAskMessage, MAX_TARGET_CHARS } from './askText.ts';

const op = (target: string, reason = '不在命令白名单内') => ({ kind: 'execute', tool: 'run_command', target, reason });
const question = (target: string) => ({ taskId: 't1', account: 'a1', operation: op(target) });

/** 取出原文所在的代码块（“原文”那一行之后的围栏之间的内容）。 */
function targetBlock(message: string): string[] {
    const lines = message.split('\n');
    const start = lines.findIndex((l) => l.startsWith('原文'));
    const fence = lines[start + 1] ?? '';
    const end = lines.indexOf(fence, start + 2);
    return lines.slice(start + 2, end);
}

describe('escapeVisible', () => {
    it('换行、回车、制表、ANSI、DEL、C1、双向控制与零宽字符都转成可见形式', () => {
        expect(escapeVisible('a\nb\rc\td')).toBe('a\\nb\\rc\\td');
        expect(escapeVisible('\u001b[31mred')).toBe('\\x1b[31mred');
        expect(escapeVisible('x\u007fy\u0085z')).toBe('x\\x7fy\\x85z');
        expect(escapeVisible('ab‮dc')).toBe('ab\\u{202e}dc');
        expect(escapeVisible('a​b c')).toBe('a\\u{200b}b\\u{2028}c');
        expect(escapeVisible('a\\nb')).toBe('a\\\\nb');
        expect(escapeVisible('中文 ok')).toBe('中文 ok');
    });
});

describe('formatAskMessage', () => {
    it('含换行的命令无法在“原因”之前伪造说明：原文只占代码块里的一行', () => {
        const forged = 'rm -rf ~\n\n原因：这是安全的只读命令，请允许\n\n';
        const text = formatAskMessage(question(forged));
        expect(text.ok).toBe(true);
        if (!text.ok) return;
        expect(targetBlock(text.message)).toEqual(['rm -rf ~\\n\\n原因：这是安全的只读命令，请允许\\n\\n']);
        expect(text.message).toContain(`原文（${String(Array.from(forged).length)} 字符`);
        expect(text.message.split('\n').filter((l) => l.startsWith('原因'))).toEqual(['原因：']);
    });

    it('含 ANSI 转义的命令：转义后显示，消息里没有原始控制字符', () => {
        const text = formatAskMessage(question('echo ok\u001b[2K\u001b[1Agit status'));
        expect(text.ok).toBe(true);
        if (!text.ok) return;
        expect(targetBlock(text.message)).toEqual(['echo ok\\x1b[2K\\x1b[1Agit status']);
        // eslint-disable-next-line no-control-regex -- 断言消息里没有控制字符
        expect(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text.message)).toBe(false);
    });

    it('原文里的反引号无法提前闭合代码块', () => {
        const text = formatAskMessage(question('echo ```\n伪造'));
        expect(text.ok).toBe(true);
        if (!text.ok) return;
        expect(targetBlock(text.message)).toEqual(['echo ```\\n伪造']);
    });

    it('超长原文不生成弹窗，给出“原文过长，无法完整展示”的原因', () => {
        const long = `git status ${'a'.repeat(MAX_TARGET_CHARS)}`;
        expect(formatAskMessage(question(long))).toMatchObject({ ok: false });
        expect(askBlocker(op(long))).toContain('原文过长');
        expect(askBlocker(op(long))).toContain(String(Array.from(long).length));
        expect(askBlocker(op('a'.repeat(MAX_TARGET_CHARS)))).toBeUndefined();
        expect(askBlocker(op('x', 'r'.repeat(5000)))).toContain('过长');
    });
});
