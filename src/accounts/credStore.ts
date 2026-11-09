import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.ts';

const execFileAsync = promisify(execFile);

/**
 * macOS：账号 HOME 里有独立的空钥匙串时，启动 agy 前先解锁（重启后它会处于锁定状态）。
 * 没有该钥匙串或不是 macOS 则什么都不做；解锁失败只告警，由后续 agy 的登录错误给出真正原因。
 * 做法见 docs/acp-验证结论.md §2.2。
 */
export async function unlockAccountKeychain(accountHome: string): Promise<void> {
    if (process.platform !== 'darwin') return;
    const keychain = path.join(accountHome, 'Library', 'Keychains', 'agy.keychain-db');
    if (!existsSync(keychain)) return;
    try {
        await execFileAsync('security', ['unlock-keychain', '-p', '', keychain], {
            env: { ...process.env, HOME: accountHome },
        });
    } catch (err) {
        log.warn('解锁账号钥匙串失败', { keychain, error: String(err) });
    }
}
