import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { Collector } from './collector.ts';

const note = (update: SessionNotification['update']): SessionNotification => ({ sessionId: 's', update });
const text = (t: string) => note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });

describe('Collector', () => {
    it('最终汇报只取最后一次工具调用之后的文本', () => {
        const c = new Collector();
        c.startTurn();
        c.handle(text('先看看文件。'));
        c.handle(
            note({
                sessionUpdate: 'tool_call',
                toolCallId: '1',
                title: '写文件',
                kind: 'edit',
                locations: [{ path: '/w/a.txt' }],
            }),
        );
        c.handle(note({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed' }));
        c.handle(text('完成'));
        c.handle(text('了。'));
        expect(c.finalText).toBe('完成了。');
        expect(c.text).toBe('先看看文件。完成了。');
        expect(c.toolCalls).toEqual([{ id: '1', title: '写文件', kind: 'edit', status: 'completed' }]);
        expect(c.editedPaths).toEqual(['/w/a.txt']);
    });

    it('startTurn 清空上一轮文本，记录用量', () => {
        const c = new Collector();
        c.handle(text('旧'));
        c.startTurn();
        c.handle(note({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.5, currency: 'USD' } }));
        expect(c.text).toBe('');
        expect(c.usage).toEqual({ contextUsed: 10, contextSize: 100, costAmount: 0.5, costCurrency: 'USD' });
    });
});
