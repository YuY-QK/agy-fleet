import os from 'node:os';
import path from 'node:path';

export interface FleetConfig {
    /** agy 可执行文件与启动 ACP 的参数。 */
    agyBin: string;
    agyArgs: string[];
    /** 数据目录：账号库、租约、任务记录、日志、worktree 都在其下（可分别覆盖）。 */
    dataDir: string;
    accountsFile: string;
    leaseDir: string;
    taskDir: string;
    logDir: string;
    worktreeRoot: string;
    /** 仅开发测试用：额外登记一个账号 HOME（名称取目录名），等同于在账号库里加一条。 */
    envAccountHome?: string;
    /** 启动时解除暂停的账号名；`*` 表示全部（M3 的 `account resume` 命令出现前的最小恢复方式）。 */
    resumeAccounts: string[];
    /** 单轮超时（毫秒）。 */
    turnTimeoutMs: number;
    /** 一轮结束后保留子进程等待续聊的时间，超时关闭子进程（会话仍可 session/load 恢复）。 */
    idleTimeoutMs: number;
    /** 每账号同时运行的任务数（账号库条目的 maxConcurrency 可覆盖）与全局上限。 */
    perAccountConcurrency: number;
    globalConcurrency: number;
    /** 租约心跳间隔与过期时间。 */
    leaseHeartbeatMs: number;
    leaseTtlMs: number;
    /** wait_task 单次等待的默认值与上限（秒）。 */
    waitDefaultS: number;
    waitMaxS: number;
}

const MINUTE = 60 * 1000;

function positive(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return raw !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 从环境变量读配置。所有项都有默认值；账号来自账号库（`accounts.json`）。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
    const dataDir = path.resolve(env.AGY_FLEET_DATA_DIR ?? path.join(os.homedir(), '.agy-fleet'));
    const accountHome = env.AGY_FLEET_ACCOUNT_HOME;
    return {
        agyBin: env.AGY_FLEET_AGY_BIN ?? 'agy',
        agyArgs: ['acp'],
        dataDir,
        accountsFile: path.resolve(env.AGY_FLEET_ACCOUNTS_FILE ?? path.join(dataDir, 'accounts.json')),
        leaseDir: path.join(dataDir, 'leases'),
        taskDir: path.join(dataDir, 'tasks'),
        logDir: path.join(dataDir, 'logs'),
        worktreeRoot: env.AGY_FLEET_WORKTREE_ROOT ?? path.join(dataDir, 'worktrees'),
        ...(accountHome ? { envAccountHome: path.resolve(accountHome) } : {}),
        resumeAccounts: (env.AGY_FLEET_RESUME ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== ''),
        turnTimeoutMs: positive(env.AGY_FLEET_TURN_TIMEOUT_MINUTES, 30) * MINUTE,
        idleTimeoutMs: positive(env.AGY_FLEET_IDLE_TIMEOUT_MINUTES, 30) * MINUTE,
        perAccountConcurrency: Math.floor(positive(env.AGY_FLEET_PER_ACCOUNT_CONCURRENCY, 1)),
        globalConcurrency: Math.floor(positive(env.AGY_FLEET_GLOBAL_CONCURRENCY, 4)),
        leaseHeartbeatMs: 5_000,
        leaseTtlMs: 30_000,
        waitDefaultS: 45,
        waitMaxS: 300,
    };
}
