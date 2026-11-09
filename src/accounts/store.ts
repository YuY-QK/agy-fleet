import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FleetError } from '../errors.ts';
import { withFileLock, writeFileAtomic } from '../fsutil.ts';

// 账号库：`accounts.json`。多个 agy-fleet 进程共享，所以每次读都重新读文件，
// 每次改都在文件锁里“读-改-原子写”。账号本身（HOME、登录）由使用者准备，M3 才有 `account` 命令。

const PauseInfoSchema = z.object({
    /** 触发暂停的错误码。 */
    code: z.string(),
    reason: z.string(),
    at: z.string(),
});

const AccountSchema = z.looseObject({
    name: z.string().min(1),
    home: z.string().min(1),
    email: z.string().optional(),
    /** 覆盖全局的每账号并发上限。 */
    maxConcurrency: z.number().int().positive().optional(),
    /** 整个账号被暂停（登录失效等）。 */
    paused: PauseInfoSchema.optional(),
    /** “账号 + 模型”被暂停（额度用尽），键为模型名；未指定模型用 DEFAULT_MODEL_KEY。 */
    pausedModels: z.record(z.string(), PauseInfoSchema).optional(),
});

const FileSchema = z.looseObject({ version: z.number().optional(), accounts: z.array(AccountSchema) });

export type PauseInfo = z.infer<typeof PauseInfoSchema>;
export type AccountRecord = z.infer<typeof AccountSchema>;

/** 任务没有指定模型（沿用 agy 默认）时，暂停记录用的键。 */
export const DEFAULT_MODEL_KEY = '(default)';

export class AccountStore {
    readonly file: string;

    constructor(file: string) {
        this.file = file;
    }

    list(): AccountRecord[] {
        return this.#read().accounts;
    }

    get(name: string): AccountRecord | undefined {
        return this.list().find((a) => a.name === name);
    }

    /** 账号库里没有同名账号时才新增（用于环境变量登记的开发账号）。 */
    ensure(account: { name: string; home: string }): void {
        this.#update((accounts) => {
            if (!accounts.some((a) => a.name === account.name)) accounts.push({ ...account });
        });
    }

    /** 该账号用 `model` 跑任务是否被暂停；返回暂停信息，没有暂停返回 undefined。 */
    pauseFor(name: string, model: string | undefined): PauseInfo | undefined {
        const account = this.get(name);
        if (account === undefined) return undefined;
        return account.paused ?? account.pausedModels?.[model ?? DEFAULT_MODEL_KEY];
    }

    pauseAccount(name: string, info: PauseInfo): void {
        this.#mutate(name, (account) => {
            account.paused = info;
        });
    }

    pauseModel(name: string, model: string | undefined, info: PauseInfo): void {
        this.#mutate(name, (account) => {
            account.pausedModels = { ...account.pausedModels, [model ?? DEFAULT_MODEL_KEY]: info };
        });
    }

    /**
     * 解除暂停。不给 `model` 时清掉整个账号的暂停和所有模型暂停；给了只清该模型。
     * 正式的 `account resume` 命令在 M3，这里是内部函数与环境变量 `AGY_FLEET_RESUME` 的实现。
     */
    resume(name: string, model?: string): void {
        this.#mutate(name, (account) => {
            if (model === undefined) {
                delete account.paused;
                delete account.pausedModels;
            } else if (account.pausedModels !== undefined) {
                const rest = Object.entries(account.pausedModels).filter(([key]) => key !== model);
                if (rest.length === 0) delete account.pausedModels;
                else account.pausedModels = Object.fromEntries(rest);
            }
        });
    }

    resumeAll(): void {
        this.#update((accounts) => {
            for (const account of accounts) {
                delete account.paused;
                delete account.pausedModels;
            }
        });
    }

    #mutate(name: string, fn: (account: AccountRecord) => void): void {
        const state = { found: false };
        this.#update((accounts) => {
            const account = accounts.find((a) => a.name === name);
            if (account !== undefined) {
                state.found = true;
                fn(account);
            }
        });
        if (!state.found) throw new FleetError('invalid_input', `账号库里没有账号：${name}`);
    }

    #read(): z.infer<typeof FileSchema> {
        if (!existsSync(this.file)) return { accounts: [] };
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(this.file, 'utf8'));
        } catch (err) {
            throw new FleetError('invalid_input', `账号库不是合法 JSON：${this.file}（${String(err)}）`);
        }
        const parsed = FileSchema.safeParse(raw);
        if (!parsed.success) {
            throw new FleetError('invalid_input', `账号库格式不对：${this.file}（${parsed.error.message}）`);
        }
        return parsed.data;
    }

    #update(fn: (accounts: AccountRecord[]) => void): void {
        withFileLock(`${this.file}.lock`, () => {
            const data = this.#read();
            fn(data.accounts);
            writeFileAtomic(this.file, `${JSON.stringify({ ...data, version: 1 }, null, 2)}\n`);
        });
    }
}

/** 账号库的默认文件名所在目录（供调用方建目录用）。 */
export function accountsDir(file: string): string {
    return path.dirname(file);
}
