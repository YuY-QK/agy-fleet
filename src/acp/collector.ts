import type { SessionNotification } from '@agentclientprotocol/sdk';

export interface ToolCallRecord {
    id: string;
    title: string;
    kind: string;
    status: string;
}

export interface UsageSnapshot {
    contextUsed: number;
    contextSize: number;
    costAmount?: number;
    costCurrency?: string;
}

const MUTATING_KINDS = new Set(['edit', 'delete', 'move']);

/**
 * 把一个会话的 `session/update` 通知折叠成调用方关心的几样东西：
 * 整段文本、“最后一次工具调用之后”的收尾文本、工具调用表、改动过的路径、用量快照。
 * 文本按轮次清空；工具调用、改动路径、用量跨轮累计。
 */
export class Collector {
    /** 本轮全部 agent 文本。 */
    text = '';
    /** 本轮最后一次工具调用之后的 agent 文本，即最终汇报。 */
    #finalFrom = 0;
    #calls = new Map<string, ToolCallRecord>();
    #edited = new Set<string>();
    #usage: UsageSnapshot | undefined;

    get finalText(): string {
        return this.text.slice(this.#finalFrom);
    }

    get toolCalls(): ToolCallRecord[] {
        return [...this.#calls.values()];
    }

    get editedPaths(): string[] {
        return [...this.#edited];
    }

    get usage(): UsageSnapshot | undefined {
        return this.#usage;
    }

    startTurn(): void {
        this.text = '';
        this.#finalFrom = 0;
    }

    handle(notification: SessionNotification): void {
        const update = notification.update;
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type === 'text') this.text += update.content.text;
                break;
            case 'tool_call': {
                this.#finalFrom = this.text.length;
                const record: ToolCallRecord = {
                    id: update.toolCallId,
                    title: update.title,
                    kind: update.kind ?? 'other',
                    status: update.status ?? 'pending',
                };
                this.#calls.set(record.id, record);
                this.#noteLocations(record.kind, update.locations);
                break;
            }
            case 'tool_call_update': {
                const record = this.#calls.get(update.toolCallId);
                if (record === undefined) break;
                if (update.title != null) record.title = update.title;
                if (update.kind != null) record.kind = update.kind;
                if (update.status != null) record.status = update.status;
                this.#noteLocations(record.kind, update.locations);
                break;
            }
            case 'usage_update': {
                const snapshot: UsageSnapshot = { contextUsed: update.used, contextSize: update.size };
                if (update.cost != null) {
                    snapshot.costAmount = update.cost.amount;
                    snapshot.costCurrency = update.cost.currency;
                }
                this.#usage = snapshot;
                break;
            }
            default:
                break;
        }
    }

    #noteLocations(kind: string, locations: { path: string }[] | null | undefined): void {
        if (!MUTATING_KINDS.has(kind)) return;
        for (const location of locations ?? []) this.#edited.add(location.path);
    }
}
