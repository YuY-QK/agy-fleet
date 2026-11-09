import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// 两类日志：
//  1. 服务器日志：写 stderr（stdout 被 MCP 传输占用，绝不能写）；
//  2. 任务日志：每个任务一个文件，只记事件，不记令牌与环境变量。

type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
    const configured = process.env.AGY_FLEET_LOG_LEVEL;
    return configured !== undefined && configured in LEVEL_RANK ? LEVEL_RANK[configured as Level] : LEVEL_RANK.info;
}

function formatFields(fields: LogFields | undefined): string {
    if (fields === undefined) return '';
    try {
        return ` ${JSON.stringify(fields)}`;
    } catch {
        return ' {"_":"字段无法序列化"}';
    }
}

function emit(level: Level, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < threshold()) return;
    process.stderr.write(`${new Date().toISOString()} [${level}] ${message}${formatFields(fields)}\n`);
}

export const log = {
    debug: (message: string, fields?: LogFields): void => {
        emit('debug', message, fields);
    },
    info: (message: string, fields?: LogFields): void => {
        emit('info', message, fields);
    },
    warn: (message: string, fields?: LogFields): void => {
        emit('warn', message, fields);
    },
    error: (message: string, fields?: LogFields): void => {
        emit('error', message, fields);
    },
};

/** 单个任务的日志文件。写入失败只告警，不影响任务。 */
export interface TaskLog {
    readonly file: string;
    write(event: string, fields?: LogFields): void;
}

export function openTaskLog(dir: string, taskId: string): TaskLog {
    const file = path.join(dir, `${taskId}.log`);
    let usable = true;
    try {
        mkdirSync(dir, { recursive: true });
    } catch (err) {
        usable = false;
        log.warn('无法创建任务日志目录', { dir, error: String(err) });
    }
    return {
        file,
        write(event, fields) {
            if (!usable) return;
            try {
                appendFileSync(file, `${new Date().toISOString()} ${event}${formatFields(fields)}\n`);
            } catch (err) {
                usable = false;
                log.warn('写任务日志失败，之后不再写', { file, error: String(err) });
            }
        },
    };
}
