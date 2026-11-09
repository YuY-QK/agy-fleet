/** 对调用方可见的错误码（PLAN §6.7，M1 只用到其中一部分）。 */
export type ErrorCode =
    | 'agy_not_found'
    | 'account_not_logged_in'
    | 'agent_crashed'
    | 'worktree_failed'
    | 'invalid_input'
    | 'timeout'
    | 'cancelled';

export class FleetError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message: string) {
        super(message);
        this.name = 'FleetError';
        this.code = code;
    }
}
