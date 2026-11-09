import os from 'node:os';
import path from 'node:path';
import { FleetError } from './errors.ts';

export interface FleetConfig {
    /** agy 可执行文件。 */
    agyBin: string;
    /** 账号 HOME（M1：由环境变量指定；账号库留给 M2/M3）。 */
    accountHome: string;
    /** 账号在输出中的显示名。 */
    accountName: string;
    /** worktree 根目录。 */
    worktreeRoot: string;
    /** 任务日志目录。 */
    logDir: string;
    /** 单轮超时（毫秒）。 */
    turnTimeoutMs: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** 从环境变量读配置。M1 必须设置 AGY_FLEET_ACCOUNT_HOME。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
    const accountHome = env.AGY_FLEET_ACCOUNT_HOME;
    if (!accountHome) {
        throw new FleetError('invalid_input', '未设置环境变量 AGY_FLEET_ACCOUNT_HOME（账号的独立 HOME 目录）');
    }
    const dataDir = env.AGY_FLEET_DATA_DIR ?? path.join(os.homedir(), '.agy-fleet');
    const timeoutMinutes = Number(env.AGY_FLEET_TURN_TIMEOUT_MINUTES);
    return {
        agyBin: env.AGY_FLEET_AGY_BIN ?? 'agy',
        accountHome: path.resolve(accountHome),
        accountName: path.basename(path.resolve(accountHome)),
        worktreeRoot: env.AGY_FLEET_WORKTREE_ROOT ?? path.join(dataDir, 'worktrees'),
        logDir: path.join(dataDir, 'logs'),
        turnTimeoutMs: timeoutMinutes > 0 ? timeoutMinutes * 60 * 1000 : DEFAULT_TURN_TIMEOUT_MS,
    };
}
