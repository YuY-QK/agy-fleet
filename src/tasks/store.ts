import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolCallRecord, UsageSnapshot } from '../acp/collector.ts';
import { writeFileAtomic } from '../fsutil.ts';
import type { DiffStat, Worktree } from '../git/worktree.ts';
import type { ApprovedOperation, DeniedOperation } from '../policy/permissions.ts';

// 任务记录：每个任务一个 JSON 文件，进程重启后仍可查看。
// 状态机：running → idle（本轮结束，等待审查）→ running … → closed；出错为 failed（带错误码）。
// failed 的任务如果已有会话，仍可 send_message 用 session/load 恢复。

export type TaskStatus = 'running' | 'idle' | 'failed' | 'closed';

/** 一轮的结果（字段名即对外 JSON 键，见 PLAN §7）。 */
export interface TurnResult {
    stop_reason: string;
    final_report: string;
    diff: DiffStat;
    denied: DeniedOperation[];
    /** 规则外、经用户批准的操作（outside_policy 为 ask 时才会有）。旧记录可能没有这个字段。 */
    approved?: ApprovedOperation[];
    tool_calls: ToolCallRecord[];
    usage: UsageSnapshot | null;
}

export interface TaskRecord {
    id: string;
    status: TaskStatus;
    account: string;
    model?: string;
    effort?: string;
    description?: string;
    repo: string;
    worktree: Worktree;
    sessionId?: string;
    /** 当前由哪个 agy-fleet 进程负责这个任务；该进程退出后，别的进程可以接手。 */
    ownerPid: number;
    /** 已完成的轮数。 */
    turns: number;
    createdAt: string;
    updatedAt: string;
    /** 本轮开始时间，仅 running 时有意义。 */
    turnStartedAt?: string;
    error?: { code: string; message: string };
    /** 失败时已收到的部分输出。 */
    partialReport?: string;
    /** 最近一次成功完成的一轮。 */
    result?: TurnResult;
    logFile: string;
}

export class TaskStore {
    readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    save(record: TaskRecord): void {
        record.updatedAt = new Date().toISOString();
        writeFileAtomic(path.join(this.dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }

    load(id: string): TaskRecord | undefined {
        // 任务号会进入文件路径，只接受我们自己生成的形状。
        if (!/^[A-Za-z0-9]+$/.test(id)) return undefined;
        try {
            return JSON.parse(readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as TaskRecord;
        } catch {
            return undefined;
        }
    }

    list(): TaskRecord[] {
        let names: string[];
        try {
            names = readdirSync(this.dir);
        } catch {
            return [];
        }
        const records: TaskRecord[] = [];
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const record = this.load(name.slice(0, -'.json'.length));
            if (record !== undefined) records.push(record);
        }
        return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
}
