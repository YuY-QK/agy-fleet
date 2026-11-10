#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    addAccount,
    loginAccount,
    removeAccount,
    resumeAccount,
    type AccountDeps,
    type AccountIO,
} from './accounts/setup.ts';
import { loadConfig, type FleetConfig } from './config.ts';
import { formatChecks, runDoctor } from './doctor.ts';
import { FleetError } from './errors.ts';
import { log } from './log.ts';
import { createServer } from './mcp/server.ts';
import { TaskManager } from './tasks/manager.ts';

// 命令入口。`mcp` 模式下 stdout 是 MCP 传输，只能写 stderr；其余命令是给人用的，结果写 stdout。

const USAGE = `用法：
  agy-fleet mcp                                   以 stdio 方式启动 MCP 服务器
  agy-fleet account add <名称> [--email <邮箱>] [--no-login]
                                                  新建账号（独立 HOME 与钥匙串）并在浏览器登录
  agy-fleet account login <名称>                  （重新）登录账号，成功后解除账号暂停
  agy-fleet account list [--json]                 列出账号与状态
  agy-fleet account resume <名称>|--all [--model <模型>]
                                                  解除暂停（给模型只解除该模型）
  agy-fleet account remove <名称> [--purge] [--confirm <名称>]
                                                  从账号库删除；--purge 连同账号 HOME 一起删除（需确认）
  agy-fleet doctor [--online]                     环境自检；--online 对每个账号真实运行一次 agy models

数据目录默认 ~/.agy-fleet（AGY_FLEET_DATA_DIR），配置文件 <数据目录>/config.yaml（AGY_FLEET_CONFIG）。
`;

const consoleIO: AccountIO = {
    out(line) {
        process.stdout.write(`${line}\n`);
    },
    async ask(prompt) {
        if (!process.stdin.isTTY) {
            throw new FleetError('invalid_input', '需要确认，但当前不是交互式终端；请改用 --confirm <名称>');
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            return await rl.question(prompt);
        } finally {
            rl.close();
        }
    },
};

function accountDeps(config: FleetConfig): AccountDeps {
    const manager = new TaskManager(config);
    return { config, store: manager.accounts, leases: manager.leases, io: consoleIO };
}

function listAccounts(config: FleetConfig, json: boolean): void {
    const manager = new TaskManager(config);
    const homes = new Map(manager.accounts.list().map((a) => [a.name, a.home]));
    const views = manager.listAccounts().map((view) => ({ ...view, home: homes.get(view.name) ?? '' }));
    if (json) {
        process.stdout.write(`${JSON.stringify(views, null, 2)}\n`);
        return;
    }
    if (views.length === 0) {
        process.stdout.write('账号库为空。运行 agy-fleet account add <名称> 添加账号。\n');
        return;
    }
    for (const view of views) {
        const lines = [
            `${view.name}  ${view.status}${view.email !== undefined ? `  ${view.email}` : ''}`,
            `  HOME：${view.home}`,
        ];
        if (view.running_tasks.length > 0) lines.push(`  正在运行：${view.running_tasks.join('、')}`);
        if (view.paused !== undefined)
            lines.push(`  暂停：${view.paused.code}（${view.paused.reason}，${view.paused.at}）`);
        for (const [model, info] of Object.entries(view.paused_models)) {
            lines.push(`  模型 ${model} 暂停：${info.code}（${info.reason.slice(0, 120)}，${info.at}）`);
        }
        process.stdout.write(`${lines.join('\n')}\n`);
    }
}

async function runAccount(argv: string[]): Promise<void> {
    const sub = argv[0];
    const { values, positionals } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        strict: true,
        options: {
            email: { type: 'string' },
            'no-login': { type: 'boolean' },
            json: { type: 'boolean' },
            purge: { type: 'boolean' },
            confirm: { type: 'string' },
            model: { type: 'string' },
            all: { type: 'boolean' },
        },
    });
    const name = positionals[0];
    if (positionals.length > 1) throw new FleetError('invalid_input', `多余的参数：${positionals.slice(1).join(' ')}`);
    const needName = (): string => {
        if (name === undefined) throw new FleetError('invalid_input', '缺少账号名');
        return name;
    };
    const config = loadConfig();
    switch (sub) {
        case 'add':
            await addAccount(accountDeps(config), needName(), {
                ...(values.email !== undefined ? { email: values.email } : {}),
                login: values['no-login'] !== true,
            });
            return;
        case 'login':
            await loginAccount(accountDeps(config), needName());
            return;
        case 'list':
            listAccounts(config, values.json === true);
            return;
        case 'resume':
            resumeAccount(accountDeps(config), name, {
                all: values.all === true,
                ...(values.model !== undefined ? { model: values.model } : {}),
            });
            return;
        case 'remove':
            await removeAccount(accountDeps(config), needName(), {
                purge: values.purge === true,
                ...(values.confirm !== undefined ? { confirm: values.confirm } : {}),
            });
            return;
        default:
            process.stderr.write(USAGE);
            process.exitCode = 2;
    }
}

async function runDoctorCommand(argv: string[]): Promise<void> {
    const { values } = parseArgs({ args: argv, strict: true, options: { online: { type: 'boolean' } } });
    let config: FleetConfig | { error: string };
    try {
        config = loadConfig();
    } catch (err) {
        config = { error: err instanceof Error ? err.message : String(err) };
    }
    const store = 'error' in config ? undefined : new TaskManager(config).accounts;
    let checks;
    try {
        checks = await runDoctor(config, store, { online: values.online === true });
    } catch (err) {
        // 账号库本身损坏等：作为一项失败报告。
        checks = [
            { level: 'fail' as const, subject: '账号库', detail: err instanceof Error ? err.message : String(err) },
        ];
    }
    process.stdout.write(`${formatChecks(checks)}\n`);
    if (checks.some((c) => c.level === 'fail')) process.exitCode = 1;
}

async function runMcp(): Promise<void> {
    const config = loadConfig();
    for (const warning of config.permissions.warnings) log.warn(warning);
    const manager = new TaskManager(config);
    manager.init();
    const server = createServer(manager, { askTimeoutMs: config.permissions.askTimeoutMs });

    // 客户端断开（stdin 关闭）或收到信号：取消在跑的轮次、回收子进程、释放租约，然后退出。
    let stopping = false;
    const stop = (reason: string): void => {
        if (stopping) return;
        stopping = true;
        log.info('agy-fleet 正在退出', { reason });
        void manager.shutdown().finally(() => {
            process.exit(0);
        });
    };
    server.server.onclose = () => {
        stop('客户端断开');
    };
    process.on('SIGINT', () => {
        stop('SIGINT');
    });
    process.on('SIGTERM', () => {
        stop('SIGTERM');
    });

    await server.connect(new StdioServerTransport());
    log.info('agy-fleet MCP 服务器已启动', {
        accounts: manager.accounts.list().map((a) => a.name),
        config: config.configFile ?? '(无配置文件)',
        outsidePolicy: config.permissions.outsidePolicy,
        commandRules: config.permissions.commands.length,
    });
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    switch (command) {
        case 'mcp':
            await runMcp();
            return;
        case 'account':
            await runAccount(rest);
            return;
        case 'doctor':
            await runDoctorCommand(rest);
            return;
        default:
            process.stderr.write(USAGE);
            process.exitCode = command === undefined || command === '--help' || command === '-h' ? 0 : 2;
    }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // mcp 模式走服务器日志；其余命令直接把原因告诉使用者（配置错误、账号错误都在这里）。
    if (process.argv[2] === 'mcp') log.error('启动失败', { error: message });
    else process.stderr.write(`错误：${message}\n`);
    process.exitCode = 1;
});
