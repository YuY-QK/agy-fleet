import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { credentialStatus, hasCredentials } from './accounts/credStore.ts';
import { listModels } from './accounts/models.ts';
import type { AccountStore } from './accounts/store.ts';
import type { FleetConfig } from './config.ts';

// 环境自检（PLAN §6.4）：agy、git、平台、配置、各账号的 HOME / 钥匙串 / 凭据 / 暂停状态。
// 默认只做本地静态检查：凭据只看“存不存在”，不读出秘密，也不代表令牌仍然有效；
// `online` 才对每个账号真实运行一次 `agy models`（会联网）。

const execFileAsync = promisify(execFile);

/** 实测验证过的 agy 版本（docs/acp-验证结论.md）。 */
export const VERIFIED_AGY_VERSION = '1.5.3';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
    level: CheckLevel;
    subject: string;
    detail: string;
    /** 出问题时的修复提示。 */
    hint?: string;
}

async function version(
    command: string,
    args: string[],
): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
    try {
        const { stdout } = await execFileAsync(command, args, { timeout: 15_000 });
        return { ok: true, out: stdout.trim() };
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        return { ok: false, error: e.code === 'ENOENT' ? '找不到' : e.message };
    }
}

export async function runDoctor(
    config: FleetConfig | { error: string },
    store: AccountStore | undefined,
    options: { online: boolean },
): Promise<Check[]> {
    const checks: Check[] = [];
    const platform = process.platform;
    if (platform === 'darwin') checks.push({ level: 'ok', subject: '平台', detail: 'macOS（每账号独立钥匙串）' });
    else if (platform === 'linux') {
        checks.push({ level: 'ok', subject: '平台', detail: 'Linux（不做凭据存储处理，令牌存在账号 HOME 内）' });
    } else checks.push({ level: 'fail', subject: '平台', detail: `${platform} 不受支持` });

    if ('error' in config) {
        checks.push({ level: 'fail', subject: '配置', detail: config.error, hint: '修正配置文件后重试' });
        return checks;
    }
    checks.push({
        level: 'ok',
        subject: '配置',
        detail:
            `${config.configFile ?? '没有配置文件，使用默认值'}；规则外操作：${config.permissions.outsidePolicy}；` +
            `全局命令白名单 ${String(config.permissions.commands.length)} 条，按仓库 ${String(config.permissions.repoCommands.size)} 个仓库`,
    });

    for (const warning of config.permissions.warnings) {
        checks.push({ level: 'warn', subject: '权限', detail: warning, hint: '改成精确条目，或确认能接受后果' });
    }

    const agy = await version(config.agyBin, ['--version']);
    if (!agy.ok) {
        checks.push({
            level: 'fail',
            subject: 'agy',
            detail: `${config.agyBin}：${agy.error}`,
            hint: '安装 Antigravity CLI，或用 AGY_FLEET_AGY_BIN 指定路径',
        });
    } else if (agy.out !== VERIFIED_AGY_VERSION) {
        checks.push({
            level: 'warn',
            subject: 'agy',
            detail: `版本 ${agy.out}（实测验证过的是 ${VERIFIED_AGY_VERSION}，ACP 行为或凭据存储可能有变化）`,
        });
    } else checks.push({ level: 'ok', subject: 'agy', detail: `版本 ${agy.out}` });

    const git = await version('git', ['--version']);
    checks.push(
        git.ok
            ? { level: 'ok', subject: 'git', detail: git.out }
            : { level: 'fail', subject: 'git', detail: git.error, hint: '安装 git' },
    );

    const accounts = store?.list() ?? [];
    if (accounts.length === 0) {
        checks.push({
            level: 'warn',
            subject: '账号',
            detail: '账号库为空',
            hint: '运行 agy-fleet account add <名称>',
        });
    }
    for (const account of accounts) {
        const subject = `账号 ${account.name}`;
        if (!existsSync(account.home)) {
            checks.push({ level: 'fail', subject, detail: `HOME 不存在：${account.home}` });
            continue;
        }
        const status = await credentialStatus(account.home);
        const problems: string[] = [];
        let level: CheckLevel = 'ok';
        if (status.platform === 'darwin') {
            if (status.keychain !== true) {
                problems.push('没有独立钥匙串');
                level = 'warn';
            } else if (status.keychainIsDefault !== true) {
                problems.push('独立钥匙串不是该 HOME 的默认钥匙串');
                level = 'warn';
            }
            if (status.tokenInKeychain !== true && status.fallbackTokenFile) problems.push('令牌在回退文件里');
            if (status.tokenInKeychain === true && status.fallbackTokenFile)
                problems.push('另有陈旧的回退令牌文件，可自行删除');
        }
        if (!hasCredentials(status)) {
            problems.push('没有凭据（未登录）');
            level = 'fail';
        }
        if (account.paused !== undefined) {
            problems.push(`已暂停：${account.paused.code}（${account.paused.reason}）`);
            if (level === 'ok') level = 'warn';
        }
        const pausedModels = Object.keys(account.pausedModels ?? {});
        if (pausedModels.length > 0) {
            problems.push(`模型额度暂停：${pausedModels.join('、')}`);
            if (level === 'ok') level = 'warn';
        }
        if (options.online && hasCredentials(status)) {
            try {
                const models = await listModels(config.agyBin, account.home);
                problems.push(`联网检查通过（可用模型 ${String(models.length)} 个）`);
            } catch (err) {
                problems.push(`联网检查失败：${err instanceof Error ? err.message : String(err)}`);
                level = 'fail';
            }
        }
        checks.push({
            level,
            subject,
            detail: `${account.email !== undefined ? `${account.email}，` : ''}${problems.length > 0 ? problems.join('；') : '凭据存在（未联网验证）'}`,
            ...(level !== 'ok'
                ? {
                      hint: hintFor(account.name, hasCredentials(status), account.paused?.code),
                  }
                : {}),
        });
    }
    return checks;
}

/** 修复提示：没有凭据或因未登录/登录失效暂停时只能重新登录；其余暂停（如额度）可在确认后 resume。 */
function hintFor(name: string, credentials: boolean, pausedCode: string | undefined): string {
    const needsLogin = !credentials || pausedCode === 'account_not_logged_in' || pausedCode === 'auth_expired';
    return needsLogin
        ? `运行 agy-fleet account login ${name}`
        : `确认原因已解除后运行 agy-fleet account resume ${name}（或 account login ${name} 重新登录）`;
}

const MARK: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗' };

export function formatChecks(checks: Check[]): string {
    return checks
        .map((c) => `${MARK[c.level]} ${c.subject}：${c.detail}${c.hint !== undefined ? `\n    → ${c.hint}` : ''}`)
        .join('\n');
}
