import { execFileSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readlinkSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type FleetConfig } from '../config.ts';
import { FleetError } from '../errors.ts';
import { accountKeychainPath, FALLBACK_TOKEN_FILE, snapshotChanges, snapshotUserKeychains } from './credStore.ts';
import { LeaseManager } from './lease.ts';
import { addAccount, loginAccount, removeAccount, resumeAccount, type AccountDeps } from './setup.ts';
import { AccountStore } from './store.ts';

let root: string;
let userHome: string;
let config: FleetConfig;
let output: string[];
let leases: LeaseManager;

/** 模拟登录：在账号 HOME 里写回退令牌文件（不碰任何钥匙串）。 */
const fakeLogin =
    (code = 0) =>
    (home: string): Promise<number> => {
        if (code === 0) {
            mkdirSync(path.dirname(path.join(home, FALLBACK_TOKEN_FILE)), { recursive: true });
            writeFileSync(path.join(home, FALLBACK_TOKEN_FILE), 'fake');
        }
        return Promise.resolve(code);
    };

const fixedSnapshot = () =>
    Promise.resolve({ searchList: 'l', defaultKeychain: 'd', loginKeychain: 'k', prefsHash: 'absent' });

function deps(overrides: Partial<AccountDeps> = {}, answer = ''): AccountDeps {
    return {
        config,
        store: new AccountStore(config.accountsFile),
        leases,
        io: {
            out: (line) => output.push(line),
            ask: (prompt) => {
                output.push(prompt);
                return Promise.resolve(answer);
            },
        },
        userHome,
        // 默认不碰钥匙串：钥匙串的真实行为在 credStore.test.ts 与下面的 macOS 用例里测。
        prepare: () => Promise.resolve({ prepared: false }),
        snapshot: fixedSnapshot,
        runLogin: fakeLogin(),
        ...overrides,
    };
}

async function failure(promise: Promise<unknown>): Promise<string> {
    return promise.then(
        () => 'ok',
        (e: unknown) => (e instanceof FleetError ? e.code : String(e)),
    );
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-setup-')));
    userHome = path.join(root, 'user');
    mkdirSync(userHome);
    writeFileSync(path.join(userHome, '.gitconfig'), '[user]\n  name = t\n');
    mkdirSync(path.join(userHome, '.ssh'));
    config = loadConfig({ AGY_FLEET_DATA_DIR: path.join(root, 'data') });
    leases = new LeaseManager({ dir: config.leaseDir, ttlMs: 30_000, heartbeatMs: 5_000, globalLimit: 4 });
    output = [];
});

afterEach(() => {
    leases.releaseAll();
    rmSync(root, { recursive: true, force: true });
});

describe('account add / login', () => {
    it('建 HOME、链接 .gitconfig（不链接 .ssh）、登记、登录后解除暂停', async () => {
        const d = deps();
        await addAccount(d, 'w1', { email: 'w1@example.com', login: true });
        const home = path.join(config.accountsDir, 'w1');
        expect(lstatSync(path.join(home, '.gitconfig')).isSymbolicLink()).toBe(true);
        expect(readlinkSync(path.join(home, '.gitconfig'))).toBe(path.join(userHome, '.gitconfig'));
        expect(existsSync(path.join(home, '.ssh'))).toBe(false);
        expect(d.store.get('w1')).toEqual({ name: 'w1', home, email: 'w1@example.com' });
        expect(output.join('\n')).toContain('还原为默认');
    });

    it('--no-login：登记为暂停（未登录），之后 login 解除', async () => {
        const d = deps();
        await addAccount(d, 'w1', { login: false });
        expect(d.store.get('w1')?.paused?.code).toBe('account_not_logged_in');
        await loginAccount(d, 'w1');
        expect(d.store.get('w1')?.paused).toBeUndefined();
    });

    it('登录失败（退出码非 0 / 没有凭据）时账号保持暂停', async () => {
        await addAccount(deps(), 'w1', { login: false });
        expect(await failure(loginAccount(deps({ runLogin: fakeLogin(1) }), 'w1'))).toBe('account_not_logged_in');
        expect(await failure(loginAccount(deps({ runLogin: () => Promise.resolve(0) }), 'w1'))).toBe(
            'account_not_logged_in',
        );
        expect(deps().store.get('w1')?.paused?.code).toBe('account_not_logged_in');
    });

    it('login 只解除整个账号的暂停，保留按模型的额度暂停', async () => {
        const d = deps();
        await addAccount(d, 'w1', { login: false });
        d.store.pauseModel('w1', 'm1', { code: 'quota_exhausted', reason: 'x', at: 'now' });
        await loginAccount(d, 'w1');
        expect(d.store.get('w1')?.paused).toBeUndefined();
        expect(d.store.get('w1')?.pausedModels?.m1?.code).toBe('quota_exhausted');
    });

    it('登录过程中用户本人的钥匙串被改动：报告并保持暂停（只在 macOS 上比对）', async () => {
        await addAccount(deps(), 'w1', { login: false });
        let n = 0;
        const changing = () => {
            n += 1;
            return Promise.resolve({
                searchList: 'l',
                defaultKeychain: n === 1 ? 'd' : 'reset',
                loginKeychain: 'k',
                prefsHash: 'absent',
            });
        };
        const result = await failure(loginAccount(deps({ snapshot: changing }), 'w1'));
        if (process.platform === 'darwin') {
            expect(result).toContain('KeychainSafetyError');
            expect(deps().store.get('w1')?.paused).toBeDefined();
        } else expect(result).toBe('ok');
    });

    it('拒绝非法名称、非法邮箱、重名、已存在且非空的目录', async () => {
        expect(await failure(addAccount(deps(), '../x', { login: false }))).toBe('invalid_input');
        expect(await failure(addAccount(deps(), '-x', { login: false }))).toBe('invalid_input');
        expect(await failure(addAccount(deps(), 'w1', { email: 'nope', login: false }))).toBe('invalid_input');
        await addAccount(deps(), 'w1', { login: false });
        expect(await failure(addAccount(deps(), 'w1', { login: false }))).toBe('invalid_input');
        mkdirSync(path.join(config.accountsDir, 'w2'), { recursive: true });
        writeFileSync(path.join(config.accountsDir, 'w2', 'keep.txt'), 'x');
        expect(await failure(addAccount(deps(), 'w2', { login: false }))).toBe('invalid_input');
        expect(existsSync(path.join(config.accountsDir, 'w2', 'keep.txt'))).toBe(true);
    });

    it('凭据存储准备失败：中止、不登记、保留目录', async () => {
        const d = deps({ prepare: () => Promise.reject(new Error('钥匙串坏了')) });
        expect(await failure(addAccount(d, 'w1', { login: true }))).toContain('钥匙串坏了');
        expect(d.store.get('w1')).toBeUndefined();
        expect(existsSync(path.join(config.accountsDir, 'w1'))).toBe(true);
    });
});

describe('account remove', () => {
    it('默认只删账号库条目，保留 HOME', async () => {
        const d = deps();
        await addAccount(d, 'w1', { login: true });
        await removeAccount(d, 'w1', { purge: false });
        expect(d.store.get('w1')).toBeUndefined();
        expect(existsSync(path.join(config.accountsDir, 'w1'))).toBe(true);
    });

    it('--purge：输入账号名确认后删除 HOME；输入不一致则什么都不删', async () => {
        await addAccount(deps(), 'w1', { login: true });
        const home = path.join(config.accountsDir, 'w1');
        expect(await failure(removeAccount(deps({}, 'w2'), 'w1', { purge: true }))).toBe('cancelled');
        expect(existsSync(home)).toBe(true);
        expect(deps().store.get('w1')).toBeDefined();
        await removeAccount(deps({}, 'w1'), 'w1', { purge: true });
        expect(existsSync(home)).toBe(false);
        expect(deps().store.get('w1')).toBeUndefined();
        expect(existsSync(path.join(userHome, '.gitconfig'))).toBe(true);
    });

    it('--purge 只删账号目录的直接子目录：手动登记的外部目录、符号链接永不删除', async () => {
        const d = deps();
        const external = path.join(root, 'external-acct');
        mkdirSync(external);
        d.store.add({ name: 'ext', home: external });
        expect(await failure(removeAccount(d, 'ext', { purge: true, confirm: 'ext' }))).toBe('invalid_input');
        expect(existsSync(external)).toBe(true);

        mkdirSync(config.accountsDir, { recursive: true });
        const link = path.join(config.accountsDir, 'linked');
        execFileSync('ln', ['-s', external, link]);
        d.store.add({ name: 'linked', home: link });
        expect(await failure(removeAccount(d, 'linked', { purge: true, confirm: 'linked' }))).toBe('invalid_input');
        expect(existsSync(external)).toBe(true);

        d.store.add({ name: 'nested', home: path.join(config.accountsDir, 'a', 'b') });
        mkdirSync(path.join(config.accountsDir, 'a', 'b'), { recursive: true });
        expect(await failure(removeAccount(d, 'nested', { purge: true, confirm: 'nested' }))).toBe('invalid_input');
        expect(d.store.get('ext')).toBeDefined();
    });

    it('账号正在运行任务时拒绝删除', async () => {
        const d = deps();
        await addAccount(d, 'w1', { login: true });
        const held = leases.acquire('w1', 't1', 1);
        expect(held.ok).toBe(true);
        expect(await failure(removeAccount(d, 'w1', { purge: false }))).toBe('account_busy');
        expect(d.store.get('w1')).toBeDefined();
    });
});

describe('account resume', () => {
    it('按账号、按模型、全部解除', () => {
        const d = deps();
        d.store.add({ name: 'a', home: '/h/a' });
        d.store.add({ name: 'b', home: '/h/b' });
        const info = { code: 'quota_exhausted', reason: 'x', at: 'now' };
        d.store.pauseModel('a', 'm1', info);
        d.store.pauseModel('a', 'm2', info);
        d.store.pauseAccount('b', { ...info, code: 'auth_expired' });
        resumeAccount(d, 'a', { model: 'm1', all: false });
        expect(Object.keys(d.store.get('a')?.pausedModels ?? {})).toEqual(['m2']);
        resumeAccount(d, undefined, { all: true });
        expect(d.store.get('a')?.pausedModels).toBeUndefined();
        expect(d.store.get('b')?.paused).toBeUndefined();
        expect(() => {
            resumeAccount(d, 'nope', { all: false });
        }).toThrow(FleetError);
    });
});

describe.runIf(process.platform === 'darwin')('macOS：真实的 account add（临时账号目录，模拟登录）', () => {
    it('建钥匙串并把令牌存进账号钥匙串；用户本人的钥匙串前后不变', async () => {
        const before = await snapshotUserKeychains();
        const { config: c, store, leases: l, io } = deps();
        const d: AccountDeps = {
            config: c,
            store,
            leases: l,
            io,
            // 模拟 agy 登录：把一个假令牌写进账号自己的钥匙串（HOME 指向临时目录）。
            runLogin: (home) => {
                execFileSync(
                    'security',
                    [
                        'add-generic-password',
                        '-s',
                        'gemini',
                        '-a',
                        'antigravity',
                        '-w',
                        'fake',
                        accountKeychainPath(home),
                    ],
                    { env: { ...process.env, HOME: home } },
                );
                return Promise.resolve(0);
            },
        };
        await addAccount(d, 'mac1', { login: true });
        expect(d.store.get('mac1')?.paused).toBeUndefined();
        expect(existsSync(accountKeychainPath(path.join(config.accountsDir, 'mac1')))).toBe(true);
        expect(output.join('\n')).toContain('前后无变化');
        expect(output.join('\n')).not.toContain('回退文件');
        expect(snapshotChanges(before, await snapshotUserKeychains())).toEqual([]);
    });
});
