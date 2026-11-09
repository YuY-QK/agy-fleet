import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.ts';

// 按平台准备账号的凭据存储（PLAN §6.4，做法与坑见 docs/acp-验证结论.md §2.2）。
//
// macOS：agy 把令牌存进“当前 HOME 的默认钥匙串”。给每个账号 HOME 建一个独立的空钥匙串，并把它设为该 HOME 的
// 默认钥匙串与搜索列表，账号之间、账号与用户本人之间就互不相干，登录时也不会弹“找不到钥匙串”的窗。
// 所有 `security` 调用都带 `HOME=<账号HOME>`，设置写进 `<账号HOME>/Library/Preferences/com.apple.security.plist`。
// 安全底线：建钥匙串前后比对用户真实的搜索列表、默认钥匙串、登录钥匙串与偏好文件，有任何变化立即中止并报告，
// 不做任何自动修复（修复需要用户自己判断）。
//
// Linux 等其他平台：不做处理（agy 会回退为账号 HOME 内的令牌文件）。

const execFileAsync = promisify(execFile);

/** 账号钥匙串的文件名（在 `<账号HOME>/Library/Keychains/` 下）。 */
export const KEYCHAIN_FILE = 'agy.keychain-db';
/** agy 在钥匙串里存令牌用的条目（docs/acp-验证结论.md §1）。 */
const TOKEN_SERVICE = 'gemini';
const TOKEN_ACCOUNT = 'antigravity';
/** 没有钥匙串时 agy 回退写入的令牌文件（相对账号 HOME）。 */
export const FALLBACK_TOKEN_FILE = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');

export function accountKeychainPath(accountHome: string): string {
    return path.join(accountHome, 'Library', 'Keychains', KEYCHAIN_FILE);
}

function accountPrefsPath(accountHome: string): string {
    return path.join(accountHome, 'Library', 'Preferences', 'com.apple.security.plist');
}

/** 以指定 HOME 运行 `security`。只传参数数组，不经过 shell。 */
async function security(home: string, args: string[]): Promise<{ ok: boolean; out: string }> {
    try {
        const { stdout } = await execFileAsync('security', args, {
            env: { ...process.env, HOME: home },
            timeout: 30_000,
        });
        return { ok: true, out: stdout.trim() };
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: unknown; message: string };
        return { ok: false, out: `${(e.stderr ?? '').trim() || e.message}（退出码 ${String(e.code)}）` };
    }
}

/** 用户真实钥匙串设置的快照。只读：只运行查询命令、读偏好文件的哈希。 */
export interface KeychainSnapshot {
    searchList: string;
    defaultKeychain: string;
    loginKeychain: string;
    /** 用户偏好文件 com.apple.security.plist 的 sha256；不存在为 "absent"。 */
    prefsHash: string;
}

export async function snapshotUserKeychains(userHome: string = os.homedir()): Promise<KeychainSnapshot> {
    const [searchList, defaultKeychain, loginKeychain] = await Promise.all([
        security(userHome, ['list-keychains', '-d', 'user']),
        security(userHome, ['default-keychain', '-d', 'user']),
        security(userHome, ['login-keychain', '-d', 'user']),
    ]);
    const prefs = accountPrefsPath(userHome);
    const prefsHash = existsSync(prefs) ? createHash('sha256').update(readFileSync(prefs)).digest('hex') : 'absent';
    return {
        searchList: searchList.out,
        defaultKeychain: defaultKeychain.out,
        loginKeychain: loginKeychain.out,
        prefsHash,
    };
}

const SNAPSHOT_LABELS: Record<keyof KeychainSnapshot, string> = {
    searchList: '钥匙串搜索列表（list-keychains）',
    defaultKeychain: '默认钥匙串（default-keychain）',
    loginKeychain: '登录钥匙串（login-keychain）',
    prefsHash: '偏好文件 ~/Library/Preferences/com.apple.security.plist',
};

/** 两个快照之间变化了的项（中文说明）。 */
export function snapshotChanges(before: KeychainSnapshot, after: KeychainSnapshot): string[] {
    return (Object.keys(SNAPSHOT_LABELS) as (keyof KeychainSnapshot)[])
        .filter((key) => before[key] !== after[key])
        .map((key) => `${SNAPSHOT_LABELS[key]}：之前 ${before[key]}，之后 ${after[key]}`);
}

/** 用户真实钥匙串在准备过程中被改动了。程序不做修复，交给用户检查。 */
export class KeychainSafetyError extends Error {
    readonly changes: string[];
    constructor(changes: string[]) {
        super(
            `准备账号钥匙串前后，你本人的钥匙串设置发生了变化，已中止：\n  - ${changes.join('\n  - ')}\n` +
                '程序没有做任何修复。请打开“钥匙串访问”检查；如需恢复，请自行判断后处理（不要点“还原为默认”）。',
        );
        this.name = 'KeychainSafetyError';
        this.changes = changes;
    }
}

export interface PrepareOptions {
    /** 用户本人的 HOME（用于前后比对），默认当前用户目录。 */
    userHome?: string;
    /** 取快照的方式（测试用来模拟“被改动”）。 */
    snapshot?: (userHome: string) => Promise<KeychainSnapshot>;
}

export interface PrepareResult {
    /** 是否处理了（非 macOS 为 false）。 */
    prepared: boolean;
    keychain?: string;
    /** 本次是否新建了钥匙串（已存在则只校验设置）。 */
    created?: boolean;
}

/**
 * 为账号 HOME 准备凭据存储。macOS：建独立空钥匙串（已存在则复用）并设为该 HOME 的默认钥匙串与搜索列表，
 * 写完校验设置已落盘、生效，并比对用户真实钥匙串前后无变化。任何一步失败抛错。可重复执行。
 */
export async function prepareCredentialStore(
    accountHome: string,
    options: PrepareOptions = {},
): Promise<PrepareResult> {
    if (process.platform !== 'darwin') return { prepared: false };
    const userHome = path.resolve(options.userHome ?? os.homedir());
    const home = path.resolve(accountHome);
    // 按真实路径比较（防符号链接绕过）：账号 HOME 不能是本人目录，也不能是它的上级目录。
    const real = (p: string): string => (existsSync(p) ? realpathSync(p) : p);
    const relative = path.relative(real(home), real(userHome));
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error(`账号 HOME 不能是你本人的用户目录或其上级目录：${home}`);
    }
    const snapshot = options.snapshot ?? snapshotUserKeychains;
    const keychain = accountKeychainPath(home);

    const before = await snapshot(userHome);
    // Preferences 必须先建：否则默认钥匙串设置只留在 cfprefsd 缓存里、不落盘（验证结论 §2.2 的坑）。
    mkdirSync(path.dirname(keychain), { recursive: true, mode: 0o700 });
    mkdirSync(path.dirname(accountPrefsPath(home)), { recursive: true, mode: 0o700 });

    const created = !existsSync(keychain);
    const steps: string[][] = [
        ...(created ? [['create-keychain', '-p', '', keychain]] : []),
        ['list-keychains', '-d', 'user', '-s', keychain],
        ['default-keychain', '-d', 'user', '-s', keychain],
        // 不带参数：取消自动上锁与睡眠上锁。
        ['set-keychain-settings', keychain],
        ['unlock-keychain', '-p', '', keychain],
    ];
    for (const args of steps) {
        const result = await security(home, args);
        if (!result.ok) {
            await assertUnchanged(before, snapshot, userHome);
            throw new Error(`security ${args[0] ?? ''} 失败：${result.out}`);
        }
    }

    await assertUnchanged(before, snapshot, userHome);

    if (!existsSync(accountPrefsPath(home))) {
        throw new Error(`钥匙串设置没有写入 ${accountPrefsPath(home)}，agy 登录时仍会弹窗`);
    }
    const effective = await security(home, ['default-keychain', '-d', 'user']);
    if (!pointsToAccountKeychain(effective)) {
        throw new Error(`账号 HOME 的默认钥匙串没有指向 ${keychain}：${effective.out}`);
    }
    return { prepared: true, keychain, created };
}

/** `default-keychain` 的输出是否指向账号钥匙串（输出里的路径可能是 ~/ 形式或经过 /private 解析，只比对结尾）。 */
function pointsToAccountKeychain(result: { ok: boolean; out: string }): boolean {
    return (
        result.ok &&
        result.out
            .replace(/"/g, '')
            .trim()
            .endsWith(path.join('Library', 'Keychains', KEYCHAIN_FILE))
    );
}

async function assertUnchanged(
    before: KeychainSnapshot,
    snapshot: (userHome: string) => Promise<KeychainSnapshot>,
    userHome: string,
): Promise<void> {
    const changes = snapshotChanges(before, await snapshot(userHome));
    if (changes.length > 0) throw new KeychainSafetyError(changes);
}

/**
 * macOS：账号 HOME 里有独立的空钥匙串时，启动 agy 前先解锁（重启后它会处于锁定状态）。
 * 没有该钥匙串或不是 macOS 则什么都不做；解锁失败只告警，由后续 agy 的登录错误给出真正原因。
 */
export async function unlockAccountKeychain(accountHome: string): Promise<void> {
    if (process.platform !== 'darwin') return;
    const keychain = accountKeychainPath(accountHome);
    if (!existsSync(keychain)) return;
    const result = await security(accountHome, ['unlock-keychain', '-p', '', keychain]);
    if (!result.ok) log.warn('解锁账号钥匙串失败', { keychain, error: result.out });
}

/** 账号凭据存储的现状（doctor 与登录后检查用）。只看“存不存在”，不读出任何秘密。 */
export interface CredentialStatus {
    platform: NodeJS.Platform;
    /** macOS：账号钥匙串文件是否存在。 */
    keychain?: boolean;
    /** macOS：账号 HOME 的默认钥匙串是否就是它。 */
    keychainIsDefault?: boolean;
    /** macOS：账号钥匙串里有没有 agy 的令牌条目。 */
    tokenInKeychain?: boolean;
    /** 回退令牌文件是否存在。 */
    fallbackTokenFile: boolean;
}

export async function credentialStatus(accountHome: string): Promise<CredentialStatus> {
    const fallbackTokenFile = existsSync(path.join(accountHome, FALLBACK_TOKEN_FILE));
    if (process.platform !== 'darwin') return { platform: process.platform, fallbackTokenFile };
    const keychain = accountKeychainPath(accountHome);
    if (!existsSync(keychain)) {
        return {
            platform: 'darwin',
            keychain: false,
            keychainIsDefault: false,
            tokenInKeychain: false,
            fallbackTokenFile,
        };
    }
    await unlockAccountKeychain(accountHome);
    const effective = await security(accountHome, ['default-keychain', '-d', 'user']);
    // 不带 -w / -g：只查条目是否存在，不读出密码数据。
    const token = await security(accountHome, [
        'find-generic-password',
        '-s',
        TOKEN_SERVICE,
        '-a',
        TOKEN_ACCOUNT,
        keychain,
    ]);
    return {
        platform: 'darwin',
        keychain: true,
        keychainIsDefault: pointsToAccountKeychain(effective),
        tokenInKeychain: token.ok,
        fallbackTokenFile,
    };
}

/** 是否有凭据（不代表令牌仍然有效）。 */
export function hasCredentials(status: CredentialStatus): boolean {
    return status.tokenInKeychain === true || status.fallbackTokenFile;
}
