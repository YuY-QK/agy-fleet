import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetError } from '../errors.ts';
import { DEFAULT_MODEL_KEY, AccountStore } from './store.ts';
import { parseModelList } from './models.ts';

let dir: string;
let store: AccountStore;
const info = { code: 'quota_exhausted', reason: 'RESOURCE_EXHAUSTED', at: '2026-11-09T00:00:00Z' };

beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'agy-fleet-accounts-'));
    store = new AccountStore(path.join(dir, 'accounts.json'));
    store.ensure({ name: 'a', home: '/h/a' });
    store.ensure({ name: 'b', home: '/h/b' });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('AccountStore', () => {
    it('文件不存在时是空库；ensure 不覆盖同名账号', () => {
        expect(new AccountStore(path.join(dir, 'none.json')).list()).toEqual([]);
        store.ensure({ name: 'a', home: '/other' });
        expect(store.get('a')?.home).toBe('/h/a');
    });

    it('暂停“账号+模型”只影响该模型，不影响别的模型和别的账号', () => {
        store.pauseModel('a', 'm1', info);
        expect(store.pauseFor('a', 'm1')).toMatchObject({ code: 'quota_exhausted' });
        expect(store.pauseFor('a', 'm2')).toBeUndefined();
        expect(store.pauseFor('a', undefined)).toBeUndefined();
        expect(store.pauseFor('b', 'm1')).toBeUndefined();
    });

    it('未指定模型的暂停记在默认键上', () => {
        store.pauseModel('a', undefined, info);
        expect(store.get('a')?.pausedModels).toHaveProperty([DEFAULT_MODEL_KEY]);
        expect(store.pauseFor('a', undefined)).toBeDefined();
        expect(store.pauseFor('a', 'm1')).toBeUndefined();
    });

    it('暂停整个账号对所有模型生效', () => {
        store.pauseAccount('a', { ...info, code: 'auth_expired' });
        expect(store.pauseFor('a', 'm1')?.code).toBe('auth_expired');
        expect(store.pauseFor('a', undefined)?.code).toBe('auth_expired');
        expect(store.pauseFor('b', undefined)).toBeUndefined();
    });

    it('暂停状态落盘，另一个 store 实例（模拟另一个进程）可见', () => {
        store.pauseModel('a', 'm1', info);
        const other = new AccountStore(store.file);
        expect(other.pauseFor('a', 'm1')).toBeDefined();
    });

    it('resume：按模型只清该模型；不带模型清掉账号与全部模型暂停', () => {
        store.pauseModel('a', 'm1', info);
        store.pauseModel('a', 'm2', info);
        store.pauseAccount('a', info);
        store.resume('a', 'm1');
        expect(store.get('a')?.pausedModels).toHaveProperty('m2');
        expect(store.get('a')?.pausedModels).not.toHaveProperty('m1');
        expect(store.get('a')?.paused).toBeDefined();
        store.resume('a');
        expect(store.pauseFor('a', 'm2')).toBeUndefined();
        expect(store.get('a')?.paused).toBeUndefined();
    });

    it('resumeAll 清除所有账号的暂停', () => {
        store.pauseAccount('a', info);
        store.pauseModel('b', 'm', info);
        store.resumeAll();
        expect(store.list().every((a) => a.paused === undefined && a.pausedModels === undefined)).toBe(true);
    });

    it('操作不存在的账号报 invalid_input；保留文件里未知字段', () => {
        expect(() => {
            store.pauseAccount('nope', info);
        }).toThrow(FleetError);
        const raw = JSON.parse(readFileSync(store.file, 'utf8')) as { accounts: Record<string, unknown>[] };
        raw.accounts[0] = { ...raw.accounts[0], email: 'x@y.z', future: 1 };
        writeFileSync(store.file, JSON.stringify(raw));
        store.pauseAccount('a', info);
        const after = JSON.parse(readFileSync(store.file, 'utf8')) as { accounts: { future?: number }[] };
        expect(after.accounts[0]?.future).toBe(1);
        expect(store.get('a')?.email).toBe('x@y.z');
    });

    it('损坏的账号库报错而不是被覆盖', () => {
        writeFileSync(store.file, '{ not json');
        expect(() => store.list()).toThrow('不是合法 JSON');
        expect(readFileSync(store.file, 'utf8')).toBe('{ not json');
    });
});

describe('parseModelList', () => {
    it('只取“id<TAB>名称”的行', () => {
        const out =
            'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude\n';
        expect(parseModelList(out)).toEqual([
            { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
            { id: 'claude-sonnet-4-6', name: 'Claude' },
        ]);
    });
});
