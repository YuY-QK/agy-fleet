/** 对调用方可见的错误码（PLAN §6.7）。 */
export type ErrorCode =
    | 'agy_not_found'
    | 'account_not_logged_in'
    | 'account_busy'
    | 'account_paused'
    | 'quota_exhausted'
    | 'auth_expired'
    | 'timeout'
    | 'agent_crashed'
    | 'worktree_failed'
    | 'invalid_input'
    | 'cancelled';

export class FleetError extends Error {
    readonly code: ErrorCode;
    /** 失败发生在某个任务上时，带上任务号与已有的部分输出，方便调用方继续处理。 */
    readonly taskId: string | undefined;
    readonly partial: string | undefined;

    constructor(code: ErrorCode, message: string, extra: { taskId?: string; partial?: string } = {}) {
        super(message);
        this.name = 'FleetError';
        this.code = code;
        this.taskId = extra.taskId;
        this.partial = extra.partial;
    }
}

/** 暂停的粒度：整个账号，或“账号 + 模型”组合。 */
export type PauseScope = 'account' | 'model';

/** 哪些错误码会让账号被暂停，以及暂停到什么粒度。 */
export function pauseScopeOf(code: ErrorCode): PauseScope | undefined {
    switch (code) {
        case 'quota_exhausted':
            return 'model';
        case 'auth_expired':
        case 'account_not_logged_in':
            return 'account';
        default:
            return undefined;
    }
}

// 额度用尽的表现来自对 agy 内部文本的静态分析（RESOURCE_EXHAUSTED / HTTP 429，见 docs/acp-验证结论.md §2.3），
// 尚未在真实环境触发过；原始错误文本会完整写入任务日志，以便日后校正这两条规则。
const QUOTA_PATTERN = /RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|exhausted/i;
const AUTH_PATTERN =
    /UNAUTHENTICATED|\b401\b|invalid_grant|token (has )?(expired|been revoked)|expired token|credentials? (is |are )?(invalid|expired)|re-?authenticate|please (log ?in|sign ?in)/i;

/**
 * 把一次执行中的失败归类。只有被笼统归为 `agent_crashed` 的错误才按文本重新判断；
 * 其余（超时、取消、worktree、明确的 invalid_input 等）保持原样。
 */
export function classifyFailure(err: unknown): FleetError {
    if (err instanceof FleetError) {
        if (err.code !== 'agent_crashed') return err;
        return reclassify(err.message) ?? err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return new FleetError(reclassify(message)?.code ?? 'agent_crashed', message);
}

function reclassify(message: string): FleetError | undefined {
    if (QUOTA_PATTERN.test(message)) return new FleetError('quota_exhausted', message);
    if (AUTH_PATTERN.test(message)) return new FleetError('auth_expired', message);
    return undefined;
}
