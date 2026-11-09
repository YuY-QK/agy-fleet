import { describe, expect, it } from 'vitest';
import { classifyFailure, FleetError, pauseScopeOf } from './errors.ts';

describe('classifyFailure', () => {
    it.each([
        'session/prompt 失败：rpc error（-32603） {"status":"RESOURCE_EXHAUSTED"}',
        'session/prompt 失败：HTTP 429 Too Many Requests',
        'Quota exceeded for model gemini',
    ])('额度类文本归为 quota_exhausted：%s', (message) => {
        expect(classifyFailure(new FleetError('agent_crashed', message)).code).toBe('quota_exhausted');
    });

    it.each(['UNAUTHENTICATED: access token expired (401)', 'invalid_grant: Token has been expired or revoked'])(
        '认证类文本归为 auth_expired：%s',
        (message) => {
            expect(classifyFailure(new FleetError('agent_crashed', message)).code).toBe('auth_expired');
        },
    );

    it('其他文本保持 agent_crashed，并保留原文', () => {
        const error = classifyFailure(new FleetError('agent_crashed', '进程异常退出'));
        expect(error.code).toBe('agent_crashed');
        expect(error.message).toBe('进程异常退出');
    });

    it('明确的错误码不被文本改写（例如消息里恰好有 quota 字样的 invalid_input / timeout）', () => {
        expect(classifyFailure(new FleetError('invalid_input', 'quota 参数不对')).code).toBe('invalid_input');
        expect(classifyFailure(new FleetError('timeout', '429 秒')).code).toBe('timeout');
        expect(classifyFailure(new FleetError('cancelled', '已取消')).code).toBe('cancelled');
    });

    it('非 FleetError 按文本归类', () => {
        expect(classifyFailure(new Error('RESOURCE_EXHAUSTED')).code).toBe('quota_exhausted');
        expect(classifyFailure('boom').code).toBe('agent_crashed');
    });
});

describe('pauseScopeOf', () => {
    it('额度用尽暂停“账号+模型”，认证类暂停整个账号，其余不暂停', () => {
        expect(pauseScopeOf('quota_exhausted')).toBe('model');
        expect(pauseScopeOf('auth_expired')).toBe('account');
        expect(pauseScopeOf('account_not_logged_in')).toBe('account');
        expect(pauseScopeOf('timeout')).toBeUndefined();
        expect(pauseScopeOf('agent_crashed')).toBeUndefined();
        expect(pauseScopeOf('cancelled')).toBeUndefined();
    });
});
