import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    accountKeychainPath,
    credentialStatus,
    hasCredentials,
    KeychainSafetyError,
    prepareCredentialStore,
    snapshotChanges,
    snapshotUserKeychains,
    type KeychainSnapshot,
} from './credStore.ts';

// 钥匙串相关测试只在 macOS 上跑，全部用临时目录当账号 HOME；
// 每个用例前后都比对用户本人真实的钥匙串设置（只读查询），确认测试没有碰到它。

const isMac = process.platform === 'darwin';
let root: string;
let realBefore: KeychainSnapshot;

beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-kc-')));
    if (isMac) realBefore = await snapshotUserKeychains();
});

afterAll(async () => {
    if (isMac) expect(snapshotChanges(realBefore, await snapshotUserKeychains())).toEqual([]);
    rmSync(root, { recursive: true, force: true });
});

const securityAs = (home: string, args: string[]): string =>
    execFileSync('security', args, { env: { ...process.env, HOME: home }, encoding: 'utf8' });

describe('snapshotChanges', () => {
    it('列出变化的项', () => {
        const a = { searchList: 'x', defaultKeychain: 'y', loginKeychain: 'z', prefsHash: 'absent' };
        expect(snapshotChanges(a, { ...a })).toEqual([]);
        const changes = snapshotChanges(a, { ...a, defaultKeychain: 'other', prefsHash: 'h' });
        expect(changes).toHaveLength(2);
        expect(changes[0]).toContain('default-keychain');
    });
});

describe.runIf(isMac)('macOS 账号钥匙串（临时 HOME）', () => {
    it('建独立空钥匙串：设置写进账号 HOME 的偏好文件，账号 HOME 的默认钥匙串指向它，用户本人的不变', async () => {
        const home = path.join(root, 'acct');
        mkdirSync(home);
        const before = await snapshotUserKeychains();
        const result = await prepareCredentialStore(home);
        expect(result).toMatchObject({ prepared: true, created: true, keychain: accountKeychainPath(home) });
        expect(existsSync(accountKeychainPath(home))).toBe(true);
        expect(existsSync(path.join(home, 'Library', 'Preferences', 'com.apple.security.plist'))).toBe(true);
        expect(securityAs(home, ['default-keychain', '-d', 'user'])).toContain('agy.keychain-db');
        expect(snapshotChanges(before, await snapshotUserKeychains())).toEqual([]);

        const status = await credentialStatus(home);
        expect(status).toMatchObject({ keychain: true, keychainIsDefault: true, tokenInKeychain: false });
        expect(hasCredentials(status)).toBe(false);
    });

    it('可重复执行：已有钥匙串时只校验设置，不重建', async () => {
        const home = path.join(root, 'acct');
        const result = await prepareCredentialStore(home);
        expect(result).toMatchObject({ prepared: true, created: false });
    });

    it('令牌条目存在时视为有凭据（只查存在，不读出秘密）', async () => {
        const home = path.join(root, 'acct');
        securityAs(home, [
            'add-generic-password',
            '-s',
            'gemini',
            '-a',
            'antigravity',
            '-w',
            'fake-token-for-test',
            accountKeychainPath(home),
        ]);
        const status = await credentialStatus(home);
        expect(status.tokenInKeychain).toBe(true);
        expect(hasCredentials(status)).toBe(true);
    });

    it('前后快照不一致时中止并报告，不做修复', async () => {
        const home = path.join(root, 'acct-changed');
        mkdirSync(home);
        let calls = 0;
        const fake = (): Promise<KeychainSnapshot> => {
            calls += 1;
            return Promise.resolve({
                searchList: 'list',
                defaultKeychain: calls === 1 ? 'login' : 'something-else',
                loginKeychain: 'login',
                prefsHash: 'absent',
            });
        };
        const error: unknown = await prepareCredentialStore(home, { snapshot: fake }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(KeychainSafetyError);
        expect((error as KeychainSafetyError).changes).toHaveLength(1);
        expect((error as Error).message).toContain('没有做任何修复');
    });

    it('账号 HOME 不能是用户本人的目录', async () => {
        await expect(prepareCredentialStore(os.homedir())).rejects.toThrow('本人的用户目录');
        await expect(prepareCredentialStore(path.dirname(os.homedir()))).rejects.toThrow('上级目录');
        const link = path.join(root, 'home-link');
        symlinkSync(os.homedir(), link);
        await expect(prepareCredentialStore(link)).rejects.toThrow('本人的用户目录');
    });
});

describe.runIf(!isMac)('非 macOS', () => {
    it('不做处理', async () => {
        expect(await prepareCredentialStore(path.join(root, 'x'))).toEqual({ prepared: false });
    });
});
