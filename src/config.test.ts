import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandRulesFor, ConfigError, loadConfig } from './config.ts';

let dir: string;

beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-config-')));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const writeConfig = (text: string): void => {
    writeFileSync(path.join(dir, 'config.yaml'), text);
};

describe('loadConfig', () => {
    it('没有配置文件时用默认值；权限默认拒绝、白名单为空', () => {
        const config = loadConfig({ AGY_FLEET_DATA_DIR: dir });
        expect(config.configFile).toBeUndefined();
        expect(config.accountsDir).toBe(path.join(dir, 'accounts'));
        expect(config.worktreeRoot).toBe(path.join(dir, 'worktrees'));
        expect(config.perAccountConcurrency).toBe(1);
        expect(config.permissions).toMatchObject({ outsidePolicy: 'deny', askTimeoutMs: 300_000, commands: [] });
        expect(config.defaultModel).toBeUndefined();
    });

    it('读取配置文件，环境变量优先于配置文件', () => {
        writeConfig(
            [
                'accounts_dir: ~/agy-accts',
                'per_account_concurrency: 2',
                'global_concurrency: 6',
                'turn_timeout_minutes: 10',
                'default_model: m1',
                'permissions:',
                '  outside_policy: ask',
                '  ask_timeout_seconds: 60',
                '  commands: ["git status", "git diff --stat"]',
            ].join('\n'),
        );
        const config = loadConfig({ AGY_FLEET_DATA_DIR: dir, AGY_FLEET_GLOBAL_CONCURRENCY: '3' });
        expect(config.configFile).toBe(path.join(dir, 'config.yaml'));
        expect(config.accountsDir).toBe(path.join(os.homedir(), 'agy-accts'));
        expect(config.perAccountConcurrency).toBe(2);
        expect(config.globalConcurrency).toBe(3);
        expect(config.turnTimeoutMs).toBe(10 * 60_000);
        expect(config.defaultModel).toBe('m1');
        expect(config.permissions.outsidePolicy).toBe('ask');
        expect(config.permissions.askTimeoutMs).toBe(60_000);
        expect(config.permissions.commands.map((r) => r.source)).toEqual(['git status', 'git diff --stat']);
    });

    it('按仓库的白名单以仓库真实路径为键，与全局合并', () => {
        const repo = path.join(dir, 'repo');
        mkdirSync(repo);
        symlinkSync(repo, path.join(dir, 'repo-link'));
        writeConfig(
            [
                'permissions:',
                '  commands: ["git status"]',
                '  repos:',
                `    ${path.join(dir, 'repo-link')}:`,
                '      commands: ["pnpm test"]',
            ].join('\n'),
        );
        const config = loadConfig({ AGY_FLEET_DATA_DIR: dir });
        expect(commandRulesFor(config.permissions, repo).map((r) => r.source)).toEqual(['git status', 'pnpm test']);
        expect(commandRulesFor(config.permissions, path.join(dir, 'other')).map((r) => r.source)).toEqual([
            'git status',
        ]);
    });

    it.each([
        ['不认识的字段', 'permisions:\n  outside_policy: ask\n', 'permisions'],
        ['outside_policy 取值不对', 'permissions:\n  outside_policy: allow\n', 'outside_policy'],
        ['权限里不认识的字段', 'permissions:\n  allow_all: true\n', 'allow_all'],
        ['白名单条目写了组合命令', 'permissions:\n  commands: ["git status && rm -rf /"]\n', '写法不对'],
        ['仓库键不是绝对路径', 'permissions:\n  repos:\n    relative/repo:\n      commands: []\n', '绝对路径'],
        ['不是合法 YAML', 'permissions: [\n', 'YAML'],
        ['并发不是正整数', 'per_account_concurrency: 0\n', 'per_account_concurrency'],
    ])('配置写错时报错：%s', (_name, text, hint) => {
        writeConfig(text);
        expect(() => loadConfig({ AGY_FLEET_DATA_DIR: dir })).toThrow(ConfigError);
        expect(() => loadConfig({ AGY_FLEET_DATA_DIR: dir })).toThrow(hint);
    });

    it('AGY_FLEET_CONFIG 指定的文件不存在时报错；环境变量数字写错时报错', () => {
        expect(() => loadConfig({ AGY_FLEET_DATA_DIR: dir, AGY_FLEET_CONFIG: path.join(dir, 'nope.yaml') })).toThrow(
            '不存在',
        );
        expect(() => loadConfig({ AGY_FLEET_DATA_DIR: dir, AGY_FLEET_TURN_TIMEOUT_MINUTES: 'abc' })).toThrow(
            'AGY_FLEET_TURN_TIMEOUT_MINUTES',
        );
    });

    it.each([
        'git *',
        'find *',
        'node *',
        'npm *',
        'pnpm *',
        'env *',
        'xargs *',
        'python3 *',
        'sh *',
        'bash *',
        'ssh *',
        '/usr/bin/git *',
    ])('启动器/解释器的 * 条目默认加载失败：%s', (entry) => {
        writeConfig(`permissions:\n  commands: ["${entry}"]\n`);
        expect(() => loadConfig({ AGY_FLEET_DATA_DIR: dir })).toThrow('allow_launcher_wildcards');
    });

    it('按仓库的白名单同样默认拒绝启动器 * 条目', () => {
        writeConfig(`permissions:\n  repos:\n    ${dir}:\n      commands: ["git *"]\n`);
        expect(() => loadConfig({ AGY_FLEET_DATA_DIR: dir })).toThrow('任意代码');
    });

    it('allow_launcher_wildcards: true 时接受并给出警告', () => {
        writeConfig('permissions:\n  allow_launcher_wildcards: true\n  commands: ["git *", "git status"]\n');
        const config = loadConfig({ AGY_FLEET_DATA_DIR: dir });
        expect(config.permissions.commands.map((r) => r.source)).toEqual(['git *', 'git status']);
        expect(config.permissions.warnings).toHaveLength(1);
        expect(config.permissions.warnings[0]).toContain('git *');
    });

    it('精确条目与非启动器的 * 条目不受影响，也没有警告', () => {
        writeConfig('permissions:\n  commands: ["git status", "pnpm test", "git diff *", "ls *"]\n');
        expect(() => loadConfig({ AGY_FLEET_DATA_DIR: dir })).toThrow('git diff *');
        writeConfig('permissions:\n  commands: ["git status", "pnpm test", "ls *", "cat *"]\n');
        const config = loadConfig({ AGY_FLEET_DATA_DIR: dir });
        expect(config.permissions.commands).toHaveLength(4);
        expect(config.permissions.warnings).toEqual([]);
    });

    it('空配置文件等同没有配置', () => {
        writeConfig('');
        expect(loadConfig({ AGY_FLEET_DATA_DIR: dir }).permissions.outsidePolicy).toBe('deny');
    });
});
