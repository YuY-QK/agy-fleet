import { describe, expect, it } from 'vitest';
import { matchCommand, parseCommandRule, splitCommand } from './commands.ts';

const rules = ['git status', 'git diff *', 'pnpm test', "echo 'hello world'"].map(parseCommandRule);
const allowed = (command: string): boolean => matchCommand(command, rules).matched;

describe('splitCommand', () => {
    it('按空格与制表符拆词，支持单双引号', () => {
        expect(splitCommand('  git   diff\t--stat ')).toEqual({ ok: true, words: ['git', 'diff', '--stat'] });
        expect(splitCommand(`echo 'a b' "c d" e'f'"g"`)).toEqual({ ok: true, words: ['echo', 'a b', 'c d', 'efg'] });
        expect(splitCommand(`echo ''`)).toEqual({ ok: true, words: ['echo', ''] });
    });

    it('单引号内的特殊字符按字面处理', () => {
        expect(splitCommand(`echo '$HOME; rm -rf / | x'`)).toEqual({
            ok: true,
            words: ['echo', '$HOME; rm -rf / | x'],
        });
    });

    it.each([
        ['git status && rm -rf /', '&'],
        ['git status; rm -rf /', ';'],
        ['git status || true', '|'],
        ['git status | sh', '|'],
        ['git status & sleep 1', '&'],
        ['git status > /tmp/x', '>'],
        ['git status >> /tmp/x', '>'],
        ['git status < /etc/passwd', '<'],
        ['git status 2>&1', '>'],
        ['(git status)', '('],
        ['{ git status; }', '{'],
        ['git $(rm -rf /)', '$'],
        ['git `rm -rf /`', '`'],
        ['git ${IFS}status', '$'],
        ['git status $HOME', '$'],
        ['git sta\\\ntus', '\\'],
        ['git\\ status', '\\'],
        ['git status *', '*'],
        ['git status ?', '?'],
        ['git status [a]', '['],
        ['git status ~/x', '~'],
        ['git status #comment', '#'],
        ['!git status', '!'],
        ['git status <(ls)', '<'],
        ['git status ^x', '^'],
        ['git diff "x" =ls', '='],
        ["git status 'a'\\b", '\\'],
    ])('拒绝 shell 控制与展开：%s', (command, ch) => {
        const result = splitCommand(command);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(ch);
    });

    it.each([
        ['git status\nrm -rf /', '换行'],
        ['git status\rrm', '换行'],
        ['git status\u0000', '控制字符'],
        ['git status\u001b[0m', '控制字符'],
        [`echo "unterminated`, '引号'],
        [`echo 'unterminated`, '引号'],
        [`echo "$(rm -rf /)"`, '双引号'],
        ['echo "`id`"', '双引号'],
        ['echo "\\""', '双引号'],
        ['PATH=/tmp git status', '变量赋值'],
        ['GIT_DIR=/elsewhere/.git git status', '变量赋值'],
        ["'A=1' git status", '变量赋值'],
        ['', '为空'],
        ['   ', '为空'],
    ])('拒绝换行、控制字符、未闭合引号、变量赋值、空命令：%j', (command, reason) => {
        const result = splitCommand(command);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(reason);
    });

    it('非 ASCII 字符按字面处理（如中文文件名）', () => {
        expect(splitCommand('cat 说明.md')).toEqual({ ok: true, words: ['cat', '说明.md'] });
    });

    it('第一个词以外的 = 不算赋值', () => {
        expect(splitCommand('git log --format=oneline')).toEqual({
            ok: true,
            words: ['git', 'log', '--format=oneline'],
        });
    });
});

describe('matchCommand', () => {
    it('普通条目要求完全相同', () => {
        expect(allowed('git status')).toBe(true);
        expect(allowed('  git  status ')).toBe(true);
        expect(allowed('\'git\' "status"')).toBe(true);
        expect(allowed('git status --short')).toBe(false);
        expect(allowed('git')).toBe(false);
        expect(allowed('pnpm test')).toBe(true);
        expect(allowed('pnpm test --watch')).toBe(false);
        expect(allowed('pnpm testx')).toBe(false);
        expect(allowed('/usr/bin/git status')).toBe(false);
        expect(allowed("echo 'hello world'")).toBe(true);
        expect(allowed('echo hello world')).toBe(false);
    });

    it('末尾 * 的条目允许追加参数（含零个）', () => {
        expect(allowed('git diff')).toBe(true);
        expect(allowed('git diff --stat HEAD')).toBe(true);
        expect(allowed('git diff HEAD^')).toBe(false);
        expect(allowed('git diffx')).toBe(false);
        expect(allowed('git log')).toBe(false);
    });

    it('组合命令即使每段都在白名单里也不命中', () => {
        for (const command of [
            'git status && git diff',
            'git status; git diff',
            'git status | git diff',
            'git diff $(echo x)',
            'git diff `echo x`',
            'git diff > out.txt',
            'git status\ngit diff',
            'git diff "$(rm -rf /)"',
        ]) {
            expect(allowed(command), command).toBe(false);
        }
    });

    it('空白名单给出明确原因', () => {
        expect(matchCommand('git status', [])).toEqual({ matched: false, reason: '命令白名单为空' });
    });
});

describe('parseCommandRule', () => {
    it('条目本身写了特殊字符则报错', () => {
        expect(() => parseCommandRule('git status && rm')).toThrow('写法不对');
        expect(() => parseCommandRule('FOO=1 make')).toThrow('写法不对');
        expect(() => parseCommandRule('*')).toThrow('写法不对');
        expect(() => parseCommandRule('git * diff')).toThrow('写法不对');
    });

    it('末尾 * 解析为允许追加参数', () => {
        expect(parseCommandRule('git diff *')).toMatchObject({ words: ['git', 'diff'], allowExtraArgs: true });
        expect(parseCommandRule('git diff')).toMatchObject({ words: ['git', 'diff'], allowExtraArgs: false });
    });
});
