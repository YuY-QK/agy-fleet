import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FleetConfig } from '../config.ts';
import { FleetError } from '../errors.ts';
import type { LeaseManager } from './lease.ts';
import type { AccountStore } from './store.ts';
import {
    credentialStatus,
    hasCredentials,
    KeychainSafetyError,
    prepareCredentialStore,
    snapshotChanges,
    snapshotUserKeychains,
    type KeychainSnapshot,
    type PrepareResult,
} from './credStore.ts';

// 账号命令的实现：add / login / remove / resume（PLAN §6.4）。
// 只操作 agy-fleet 自己的账号库与账号 HOME；登录由使用者在浏览器里亲自完成。

/** 命令行交互：输出一行、读一行确认。 */
export interface AccountIO {
    out(line: string): void;
    ask(prompt: string): Promise<string>;
}

export interface AccountDeps {
    config: FleetConfig;
    store: AccountStore;
    leases: LeaseManager;
    io: AccountIO;
    /** 用户本人的 HOME（链接 .gitconfig、比对钥匙串用），默认当前用户目录。 */
    userHome?: string;
    /** 以下可替换，供测试使用。 */
    prepare?: (accountHome: string) => Promise<PrepareResult>;
    snapshot?: (userHome: string) => Promise<KeychainSnapshot>;
    runLogin?: (accountHome: string) => Promise<number>;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

function userHomeOf(deps: AccountDeps): string {
    return path.resolve(deps.userHome ?? os.homedir());
}

/** 前台运行 `agy acp --login`，终端直接交给 agy（浏览器授权由使用者完成），返回退出码。 */
function spawnLogin(agyBin: string, accountHome: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(agyBin, ['acp', '--login'], {
            stdio: 'inherit',
            env: { ...process.env, HOME: accountHome },
            cwd: accountHome,
        });
        child.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new FleetError('agy_not_found', `找不到可执行文件：${agyBin}（请先安装 Antigravity CLI）`));
            } else reject(err);
        });
        child.on('exit', (code, signal) => {
            resolve(code ?? (signal !== null ? 128 : 1));
        });
    });
}

function linkGitConfig(deps: AccountDeps, home: string): void {
    const source = path.join(userHomeOf(deps), '.gitconfig');
    const target = path.join(home, '.gitconfig');
    if (!existsSync(source)) {
        deps.io.out('  · 没有找到 ~/.gitconfig，跳过链接（工作进程里的 git 将读不到你的 git 配置）');
        return;
    }
    let exists = false;
    try {
        lstatSync(target);
        exists = true;
    } catch {
        // 不存在
    }
    if (exists) {
        deps.io.out('  · 账号 HOME 里已有 .gitconfig，保持不动');
        return;
    }
    symlinkSync(source, target);
    deps.io.out('  ✓ 已把 ~/.gitconfig 链接进账号 HOME（~/.ssh 不链接）');
}

async function prepareStore(deps: AccountDeps, home: string): Promise<void> {
    if (process.platform !== 'darwin') {
        deps.io.out(`  · ${process.platform} 上不做凭据存储处理（agy 会把令牌存在账号 HOME 内的文件里）`);
        return;
    }
    const prepare =
        deps.prepare ??
        ((accountHome: string) =>
            prepareCredentialStore(accountHome, {
                userHome: userHomeOf(deps),
                ...(deps.snapshot !== undefined ? { snapshot: deps.snapshot } : {}),
            }));
    const result = await prepare(home);
    if (result.prepared) {
        deps.io.out(
            `  ✓ ${result.created === true ? '已建' : '已校验'}账号独立的空钥匙串，并设为该账号 HOME 的默认钥匙串：${result.keychain ?? ''}`,
        );
        deps.io.out('  ✓ 已比对：你本人的钥匙串搜索列表、默认钥匙串、登录钥匙串与偏好文件前后无变化');
    }
}

/** 新建账号：建 HOME → 准备凭据存储 → 链接 .gitconfig → 登记（标为未登录）→ 前台登录。 */
export async function addAccount(
    deps: AccountDeps,
    name: string,
    options: { email?: string; login: boolean },
): Promise<void> {
    if (!NAME_PATTERN.test(name)) {
        throw new FleetError(
            'invalid_input',
            `账号名只能用字母、数字、点、下划线、连字符，且以字母或数字开头：${name}`,
        );
    }
    if (options.email !== undefined && !EMAIL_PATTERN.test(options.email)) {
        throw new FleetError('invalid_input', `邮箱格式不对：${options.email}`);
    }
    if (deps.store.get(name) !== undefined) throw new FleetError('invalid_input', `账号库里已有账号：${name}`);

    const home = path.join(deps.config.accountsDir, name);
    if (existsSync(home) && readdirSync(home).length > 0) {
        throw new FleetError('invalid_input', `目录已存在且不为空，为避免覆盖已中止：${home}`);
    }
    deps.io.out(`添加账号 ${name}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    deps.io.out(`  ✓ 账号 HOME：${home}`);

    try {
        await prepareStore(deps, home);
    } catch (err) {
        // 不清理账号目录：出了问题要留给使用者检查。错误详情由调用方输出。
        deps.io.out(`  ✗ 凭据存储准备失败，账号目录保留在 ${home} 以便检查，账号没有登记`);
        throw err;
    }
    linkGitConfig(deps, home);

    deps.store.add({
        name,
        home,
        ...(options.email !== undefined ? { email: options.email } : {}),
        paused: {
            code: 'account_not_logged_in',
            reason: `尚未登录：请运行 agy-fleet account login ${name}`,
            at: new Date().toISOString(),
        },
    });
    deps.io.out(`  ✓ 已登记到账号库 ${deps.store.file}（登录完成前为暂停状态，不会被派任务）`);

    if (!options.login) {
        deps.io.out(`下一步：运行 agy-fleet account login ${name} 完成登录。`);
        return;
    }
    await loginAccount(deps, name);
}

/** 前台登录（或重新登录）一个已登记的账号；成功后解除整个账号的暂停，保留按模型的额度暂停。 */
export async function loginAccount(deps: AccountDeps, name: string): Promise<void> {
    const account = deps.store.get(name);
    if (account === undefined) throw new FleetError('invalid_input', `账号库里没有账号：${name}`);
    if (!existsSync(account.home)) throw new FleetError('invalid_input', `账号 HOME 不存在：${account.home}`);

    await prepareStore(deps, account.home);

    deps.io.out('');
    deps.io.out(`登录账号 ${name}：接下来由 agy 引导你在浏览器里用 Google 账号授权。`);
    deps.io.out('  注意：如果弹出“找不到用于储存 antigravity 的钥匙串”，请点「取消」，');
    deps.io.out('        绝对不要点「还原为默认」——那会重建你本人的登录钥匙串。');
    deps.io.out('');

    const isMac = process.platform === 'darwin';
    const snapshot = deps.snapshot ?? snapshotUserKeychains;
    const before = isMac ? await snapshot(userHomeOf(deps)) : undefined;
    const run = deps.runLogin ?? ((home: string) => spawnLogin(deps.config.agyBin, home));
    const code = await run(account.home);

    // 登录过程中如果有人点了“还原为默认”之类的按钮，会改动用户本人的钥匙串：照实报告，不做修复。
    if (before !== undefined) {
        const changes = snapshotChanges(before, await snapshot(userHomeOf(deps)));
        if (changes.length > 0) throw new KeychainSafetyError(changes);
    }
    if (code !== 0) {
        throw new FleetError('account_not_logged_in', `登录没有完成（agy 退出码 ${String(code)}），账号保持暂停`);
    }

    const status = await credentialStatus(account.home);
    if (!hasCredentials(status)) {
        throw new FleetError('account_not_logged_in', '登录命令已结束，但账号 HOME 里没有找到凭据，账号保持暂停');
    }
    if (isMac && status.tokenInKeychain !== true) {
        deps.io.out('  ! 令牌写进了回退文件而不是账号钥匙串（钥匙串设置可能没有生效），可运行 agy-fleet doctor 检查');
    }
    deps.store.resumeAccountOnly(name);
    deps.io.out(`  ✓ 账号 ${name} 已登录，可以接任务了`);
}

/**
 * 删除账号。默认只删账号库条目、保留 HOME；`purge` 才删除 HOME，且须输入账号名确认，
 * 只删除位于 agy-fleet 账号目录内的 HOME（手动登记的外部目录永不删除）。账号正在使用时拒绝。
 */
export async function removeAccount(
    deps: AccountDeps,
    name: string,
    options: { purge: boolean; confirm?: string },
): Promise<void> {
    const account = deps.store.get(name);
    if (account === undefined) throw new FleetError('invalid_input', `账号库里没有账号：${name}`);
    const holders = deps.leases.list(name);
    if (holders.length > 0) {
        throw new FleetError(
            'account_busy',
            `账号 ${name} 正在运行任务（${holders.map((h) => h.taskId).join('、')}），请稍后再删`,
        );
    }

    if (!options.purge) {
        deps.store.remove(name);
        deps.io.out(`已从账号库删除 ${name}；账号 HOME 保留在 ${account.home}（要一并删除请加 --purge）`);
        return;
    }

    const home = purgeableHome(deps, account.home);
    const answer =
        options.confirm ??
        (await deps.io.ask(`将永久删除 ${home}（含该账号的钥匙串与登录凭据，不可恢复）。输入账号名 ${name} 确认：`));
    if (answer.trim() !== name) {
        deps.io.out('输入不一致，已取消，什么都没有删除。');
        throw new FleetError('cancelled', '用户未确认删除');
    }
    rmSync(home, { recursive: true, force: true });
    deps.store.remove(name);
    deps.io.out(`已删除账号 ${name} 及其 HOME ${home}`);
}

/** 只有“账号目录的直接子目录、且本身不是符号链接”的 HOME 才允许删除；返回其真实路径。 */
function purgeableHome(deps: AccountDeps, home: string): string {
    const refuse = (why: string): never => {
        throw new FleetError('invalid_input', `不删除 ${home}：${why}，没有删除任何东西`);
    };
    if (!existsSync(home)) refuse('目录不存在');
    if (lstatSync(home).isSymbolicLink()) refuse('它是符号链接');
    let accountsDir: string;
    try {
        accountsDir = realpathSync(deps.config.accountsDir);
    } catch {
        return refuse(`账号目录 ${deps.config.accountsDir} 不存在`);
    }
    const real = realpathSync(home);
    if (path.dirname(real) !== accountsDir)
        refuse(`它不在 agy-fleet 的账号目录 ${accountsDir} 内（可能是手动登记的目录）`);
    if (real === userHomeOf(deps)) refuse('它是你本人的用户目录');
    return real;
}

/** 解除暂停：给模型只解除该模型，否则解除整个账号与所有模型；`all` 对所有账号。 */
export function resumeAccount(
    deps: AccountDeps,
    name: string | undefined,
    options: { model?: string; all: boolean },
): void {
    if (options.all) {
        if (options.model !== undefined) {
            for (const account of deps.store.list()) deps.store.resume(account.name, options.model);
        } else deps.store.resumeAll();
        deps.io.out(
            options.model !== undefined ? `已解除所有账号的模型 ${options.model} 暂停` : '已解除所有账号的暂停',
        );
        return;
    }
    if (name === undefined) throw new FleetError('invalid_input', '请给出账号名，或用 --all');
    deps.store.resume(name, options.model);
    deps.io.out(
        options.model !== undefined ? `已解除 ${name} 的模型 ${options.model} 暂停` : `已解除 ${name} 的全部暂停`,
    );
}
