import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FALLBACK_TOKEN_FILE } from './accounts/credStore.ts';
import { AccountStore } from './accounts/store.ts';
import { loadConfig, type FleetConfig } from './config.ts';
import { formatChecks, runDoctor, VERIFIED_AGY_VERSION } from './doctor.ts';

let root: string;
let config: FleetConfig;
let store: AccountStore;

function fakeAgy(versionText: string): string {
    const bin = path.join(root, 'agy');
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionText}"; exit 0; fi\nexit 3\n`);
    chmodSync(bin, 0o755);
    return bin;
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-doctor-')));
    config = { ...loadConfig({ AGY_FLEET_DATA_DIR: path.join(root, 'data') }), agyBin: fakeAgy(VERIFIED_AGY_VERSION) };
    store = new AccountStore(config.accountsFile);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const levelOf = (checks: { subject: string; level: string }[], subject: string): string | undefined =>
    checks.find((c) => c.subject === subject)?.level;

describe('doctor', () => {
    it('agy、git、配置正常，空账号库给出提示', async () => {
        const checks = await runDoctor(config, store, { online: false });
        expect(levelOf(checks, 'agy')).toBe('ok');
        expect(levelOf(checks, 'git')).toBe('ok');
        expect(levelOf(checks, '配置')).toBe('ok');
        expect(levelOf(checks, '账号')).toBe('warn');
        expect(formatChecks(checks)).toContain('account add');
    });

    it('agy 找不到为失败；版本与实测不同为警告', async () => {
        expect(
            levelOf(await runDoctor({ ...config, agyBin: path.join(root, 'nope') }, store, { online: false }), 'agy'),
        ).toBe('fail');
        expect(levelOf(await runDoctor({ ...config, agyBin: fakeAgy('9.9.9') }, store, { online: false }), 'agy')).toBe(
            'warn',
        );
    });

    it('配置有误时报告失败', async () => {
        const checks = await runDoctor({ error: '配置文件字段不对' }, undefined, { online: false });
        expect(levelOf(checks, '配置')).toBe('fail');
    });

    it('账号：HOME 不存在、没有凭据为失败；有凭据但被暂停为警告', async () => {
        const withToken = path.join(root, 'h1');
        mkdirSync(path.dirname(path.join(withToken, FALLBACK_TOKEN_FILE)), { recursive: true });
        writeFileSync(path.join(withToken, FALLBACK_TOKEN_FILE), 'x');
        const empty = path.join(root, 'h2');
        mkdirSync(empty);
        store.add({
            name: 'a1',
            home: withToken,
            pausedModels: { m1: { code: 'quota_exhausted', reason: 'r', at: 'now' } },
        });
        store.add({ name: 'a2', home: empty });
        store.add({ name: 'a3', home: path.join(root, 'missing') });
        const checks = await runDoctor(config, store, { online: false });
        expect(levelOf(checks, '账号 a1')).toBe('warn');
        expect(levelOf(checks, '账号 a2')).toBe('fail');
        expect(levelOf(checks, '账号 a3')).toBe('fail');
        expect(checks.find((c) => c.subject === '账号 a1')?.hint).toContain('account resume a1');
        expect(checks.find((c) => c.subject === '账号 a2')?.hint).toBe('运行 agy-fleet account login a2');
    });

    it('--online：agy models 失败时账号为失败', async () => {
        const home = path.join(root, 'h1');
        mkdirSync(path.dirname(path.join(home, FALLBACK_TOKEN_FILE)), { recursive: true });
        writeFileSync(path.join(home, FALLBACK_TOKEN_FILE), 'x');
        store.add({ name: 'a1', home });
        const checks = await runDoctor(config, store, { online: true });
        expect(checks.find((c) => c.subject === '账号 a1')).toMatchObject({ level: 'fail' });
        expect(checks.find((c) => c.subject === '账号 a1')?.detail).toContain('联网检查失败');
    });
});
