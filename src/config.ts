import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseCommandRule, type CommandRule } from './policy/commands.ts';

// 配置来源与优先级：环境变量 > 配置文件（<数据目录>/config.yaml，或 AGY_FLEET_CONFIG 指定）> 默认值（PLAN §6.8）。
// 配置文件只在进程启动时读一次；格式或字段写错就报错退出，不静默忽略。
// 权限规则只来自这里，MCP 工具参数没有任何放宽权限的入口（PLAN §6.5）。

/** 规则外的操作如何处理：直接拒绝，或通过 MCP elicitation 询问用户。 */
export type OutsidePolicy = 'deny' | 'ask';

export interface PermissionConfig {
    outsidePolicy: OutsidePolicy;
    /** 询问用户的等待上限，超时按拒绝处理。 */
    askTimeoutMs: number;
    /** 全局命令白名单。 */
    commands: CommandRule[];
    /** 按仓库追加的命令白名单，键为仓库根目录的真实路径。 */
    repoCommands: Map<string, CommandRule[]>;
}

export interface FleetConfig {
    /** agy 可执行文件与启动 ACP 的参数。 */
    agyBin: string;
    agyArgs: string[];
    /** 数据目录：账号库、租约、任务记录、日志、worktree 都在其下（可分别覆盖）。 */
    dataDir: string;
    /** 实际读取的配置文件（不存在时为 undefined）。 */
    configFile?: string;
    accountsFile: string;
    /** `account add` 新建账号 HOME 的父目录。 */
    accountsDir: string;
    leaseDir: string;
    taskDir: string;
    logDir: string;
    worktreeRoot: string;
    /** 仅开发测试用：额外登记一个账号 HOME（名称取目录名），等同于在账号库里加一条。 */
    envAccountHome?: string;
    /** 任务没有指定时使用的模型与推理强度；都不设则沿用 agy 默认。 */
    defaultModel?: string;
    defaultEffort?: string;
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
    permissions: PermissionConfig;
}

const MINUTE = 60 * 1000;

const PositiveInt = z.number().int().positive();

const CommandList = z.array(z.string().min(1));

const FileSchema = z.strictObject({
    accounts_dir: z.string().min(1).optional(),
    worktree_root: z.string().min(1).optional(),
    per_account_concurrency: PositiveInt.optional(),
    global_concurrency: PositiveInt.optional(),
    idle_timeout_minutes: z.number().positive().optional(),
    turn_timeout_minutes: z.number().positive().optional(),
    default_model: z.string().min(1).optional(),
    default_effort: z.string().min(1).optional(),
    permissions: z
        .strictObject({
            outside_policy: z.enum(['deny', 'ask']).optional(),
            ask_timeout_seconds: z.number().positive().max(3600).optional(),
            commands: CommandList.optional(),
            repos: z.record(z.string().min(1), z.strictObject({ commands: CommandList.optional() })).optional(),
        })
        .optional(),
});

type FileConfig = z.infer<typeof FileSchema>;

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

/** `~/…` 展开为用户目录；其余按绝对路径解析。 */
function expandHome(p: string): string {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return path.resolve(p);
}

/** 尽量取真实路径（目录存在时解析符号链接），以便和 worktree 记录里的仓库根目录比较。 */
function realOrResolved(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

function positive(raw: string | undefined, name: string): number | undefined {
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`环境变量 ${name} 必须是正数：${raw}`);
    return value;
}

function parseRules(entries: string[] | undefined, where: string): CommandRule[] {
    return (entries ?? []).map((entry) => {
        try {
            return parseCommandRule(entry);
        } catch (err) {
            throw new ConfigError(`${where}：${err instanceof Error ? err.message : String(err)}`);
        }
    });
}

function readConfigFile(file: string): FileConfig {
    let raw: unknown;
    try {
        raw = parseYaml(readFileSync(file, 'utf8'));
    } catch (err) {
        throw new ConfigError(`配置文件不是合法 YAML：${file}（${err instanceof Error ? err.message : String(err)}）`);
    }
    if (raw === null || raw === undefined) return {};
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map(
                (i) =>
                    `${i.path.join('.') || '(根)'}：${i.message}${i.code === 'unrecognized_keys' ? `（${i.keys.join(', ')}）` : ''}`,
            )
            .join('；');
        throw new ConfigError(`配置文件字段不对：${file}（${issues}）`);
    }
    return parsed.data;
}

/** 读配置：环境变量 > 配置文件 > 默认值。配置有误抛 ConfigError。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
    const dataDir = path.resolve(env.AGY_FLEET_DATA_DIR ?? path.join(os.homedir(), '.agy-fleet'));
    const explicitConfig = env.AGY_FLEET_CONFIG;
    const configFile = path.resolve(explicitConfig ?? path.join(dataDir, 'config.yaml'));
    let file: FileConfig = {};
    if (existsSync(configFile)) file = readConfigFile(configFile);
    else if (explicitConfig !== undefined)
        throw new ConfigError(`AGY_FLEET_CONFIG 指定的配置文件不存在：${configFile}`);

    const perms = file.permissions ?? {};
    const repoCommands = new Map<string, CommandRule[]>();
    for (const [repo, entry] of Object.entries(perms.repos ?? {})) {
        const expanded = expandHome(repo);
        if (!path.isAbsolute(repo) && !repo.startsWith('~')) {
            throw new ConfigError(`permissions.repos 的键必须是仓库绝对路径：${repo}`);
        }
        const key = realOrResolved(expanded);
        const rules = parseRules(entry.commands, `permissions.repos.${repo}.commands`);
        repoCommands.set(key, [...(repoCommands.get(key) ?? []), ...rules]);
    }

    const accountHome = env.AGY_FLEET_ACCOUNT_HOME;
    const turnTimeout = positive(env.AGY_FLEET_TURN_TIMEOUT_MINUTES, 'AGY_FLEET_TURN_TIMEOUT_MINUTES');
    const idleTimeout = positive(env.AGY_FLEET_IDLE_TIMEOUT_MINUTES, 'AGY_FLEET_IDLE_TIMEOUT_MINUTES');
    const perAccount = positive(env.AGY_FLEET_PER_ACCOUNT_CONCURRENCY, 'AGY_FLEET_PER_ACCOUNT_CONCURRENCY');
    const global = positive(env.AGY_FLEET_GLOBAL_CONCURRENCY, 'AGY_FLEET_GLOBAL_CONCURRENCY');
    const worktreeRoot = env.AGY_FLEET_WORKTREE_ROOT ?? file.worktree_root;
    const accountsDir = env.AGY_FLEET_ACCOUNTS_DIR ?? file.accounts_dir;

    return {
        agyBin: env.AGY_FLEET_AGY_BIN ?? 'agy',
        agyArgs: ['acp'],
        dataDir,
        ...(existsSync(configFile) ? { configFile } : {}),
        accountsFile: path.resolve(env.AGY_FLEET_ACCOUNTS_FILE ?? path.join(dataDir, 'accounts.json')),
        accountsDir: accountsDir !== undefined ? expandHome(accountsDir) : path.join(dataDir, 'accounts'),
        leaseDir: path.join(dataDir, 'leases'),
        taskDir: path.join(dataDir, 'tasks'),
        logDir: path.join(dataDir, 'logs'),
        worktreeRoot: worktreeRoot !== undefined ? expandHome(worktreeRoot) : path.join(dataDir, 'worktrees'),
        ...(accountHome ? { envAccountHome: path.resolve(accountHome) } : {}),
        ...(file.default_model !== undefined ? { defaultModel: file.default_model } : {}),
        ...(file.default_effort !== undefined ? { defaultEffort: file.default_effort } : {}),
        turnTimeoutMs: (turnTimeout ?? file.turn_timeout_minutes ?? 30) * MINUTE,
        idleTimeoutMs: (idleTimeout ?? file.idle_timeout_minutes ?? 30) * MINUTE,
        perAccountConcurrency: Math.floor(perAccount ?? file.per_account_concurrency ?? 1),
        globalConcurrency: Math.floor(global ?? file.global_concurrency ?? 4),
        leaseHeartbeatMs: 5_000,
        leaseTtlMs: 30_000,
        waitDefaultS: 45,
        waitMaxS: 300,
        permissions: {
            outsidePolicy: perms.outside_policy ?? 'deny',
            askTimeoutMs: (perms.ask_timeout_seconds ?? 300) * 1000,
            commands: parseRules(perms.commands, 'permissions.commands'),
            repoCommands,
        },
    };
}

/** 本任务适用的命令白名单：全局 + 该仓库的。`repoRoot` 为仓库根目录的真实路径。 */
export function commandRulesFor(permissions: PermissionConfig, repoRoot: string): CommandRule[] {
    return [...permissions.commands, ...(permissions.repoCommands.get(repoRoot) ?? [])];
}
