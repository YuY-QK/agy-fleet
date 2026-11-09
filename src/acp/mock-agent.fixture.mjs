// 测试用的模拟 ACP agent：从 stdin 读按行分隔的 JSON-RPC，行为由环境变量 MOCK_MODE 决定。
import process from 'node:process';
import readline from 'node:readline';

const mode = process.env.MOCK_MODE ?? 'ok';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const answers = new Map();
let promptId;
let nextOutboundId = 100;

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
        case 'session/new':
            if (mode === 'authfail') {
                send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32000, message: 'Authentication required: please log in' },
                });
                return;
            }
            send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1' } });
            return;
        case 'session/prompt':
            promptId = message.id;
            if (mode === 'hang' || mode === 'stubborn') return;
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
