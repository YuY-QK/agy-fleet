// 测试用的模拟 ACP agent：从 stdin 读按行分隔的 JSON-RPC，行为由环境变量 MOCK_MODE 决定。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { setTimeout } from 'node:timers';

const mode = process.env.MOCK_MODE ?? 'ok';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const answers = new Map();
let promptId;
let nextOutboundId = 100;

// 会话：当前进程里的会话 id、模型与强度；设了 MOCK_STATE_DIR 时会话历史落盘，
// 这样“新进程 session/load”才真能看到上一个进程里的对话（和真实 agy 一样）。
const stateDir = process.env.MOCK_STATE_DIR;
let sessionId = process.env.MOCK_SESSION_ID ?? 's1';
let loaded = false;
let model = 'default';
let effort = 'default';
const stateFile = () => (stateDir === undefined ? undefined : path.join(stateDir, `${sessionId}.json`));
const readHistory = () => {
    const file = stateFile();
    return file !== undefined && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
};
const writeHistory = (history) => {
    const file = stateFile();
    if (file !== undefined) fs.writeFileSync(file, JSON.stringify(history));
};
const chunk = (text) => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});

// work 模式：在 cwd（worktree）里写一个文件，汇报里带上会话是否由 load 恢复、历史轮数、模型与强度。
async function runWork(id, promptText) {
    const delay = Number(process.env.MOCK_DELAY_MS ?? 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const history = readHistory();
    history.push(promptText);
    writeHistory(history);
    fs.appendFileSync(path.join(process.cwd(), 'work.txt'), `${promptText.split('\n').pop()}\n`);
    if (process.env.MOCK_EXIT_AFTER_PROMPT === '1') setTimeout(() => process.exit(0), 100);
    send(chunk(`完成。loaded=${String(loaded)} turns=${String(history.length)} model=${model} effort=${effort}`));
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

function askPermission(toolCall) {
    const id = nextOutboundId++;
    send({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
            sessionId: 's1',
            toolCall,
            options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
        },
    });
    return new Promise((resolve) => answers.set(id, resolve));
}

async function runPrompt(id) {
    send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '开始。' } },
        },
    });
    const edit = await askPermission({
        toolCallId: 'c1',
        title: '写文件',
        kind: 'edit',
        name: 'write_file',
        locations: [{ path: process.env.MOCK_EDIT_PATH ?? '/nowhere/a.txt' }],
    });
    const exec = await askPermission({
        toolCallId: 'c2',
        title: '运行命令',
        kind: 'execute',
        name: 'run_command',
        rawInput: { CommandLine: 'echo hi' },
    });
    const chosen = [edit, exec].map((r) => r.outcome.optionId ?? r.outcome.outcome).join(',');
    send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `选择:${chosen}` } },
        },
    });
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === undefined && answers.has(message.id)) {
        answers.get(message.id)(message.result);
        return;
    }
    switch (message.method) {
        case 'initialize':
            if (mode === 'silent') return;
            if (mode === 'crash') process.exit(3);
            send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
            return;
        case 'session/load': {
            sessionId = message.params.sessionId;
            const file = stateFile();
            if (file !== undefined && !fs.existsSync(file)) {
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'session not found' } });
                return;
            }
            loaded = true;
            for (const old of readHistory()) send(chunk(`重放历史:${old.slice(-20)}`));
            send({ jsonrpc: '2.0', id: message.id, result: {} });
            return;
        }
        case 'session/set_config_option': {
            const { configId, value } = message.params;
            if (value === 'bad') {
                send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32602, message: `Unknown model ID: ${value}` },
                });
                return;
            }
            if (configId === 'model') model = value;
            else effort = value;
            send({ jsonrpc: '2.0', id: message.id, result: { configOptions: [] } });
            return;
        }
        case 'session/new':
            if (mode === 'authfail') {
                send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32000, message: 'Authentication required: please log in' },
                });
                return;
            }
            writeHistory([]);
            send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
            return;
        case 'session/prompt':
            promptId = message.id;
            if (mode === 'hang' || mode === 'stubborn') return;
            if (mode === 'quota' || mode === 'authexp') {
                send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error:
                        mode === 'quota'
                            ? {
                                  code: -32603,
                                  message: 'rpc error: code = ResourceExhausted',
                                  data: { status: 'RESOURCE_EXHAUSTED', httpCode: 429, detail: 'Quota exceeded' },
                              }
                            : { code: -32603, message: 'UNAUTHENTICATED: access token expired (401)' },
                });
                return;
            }
            if (mode === 'work') {
                void runWork(message.id, message.params.prompt.map((p) => p.text).join(''));
                return;
            }
            void runPrompt(message.id);
            return;
        case 'session/cancel':
            if (mode === 'hang') send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
            return;
        default:
            if (message.id !== undefined) {
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } });
            }
    }
});
