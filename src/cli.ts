#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { createServer } from './mcp/server.ts';
import { TaskManager } from './tasks/manager.ts';

const USAGE =
    '用法：agy-fleet mcp    以 stdio 方式启动 MCP 服务器\n账号来自账号库 accounts.json（默认 ~/.agy-fleet/accounts.json，可用 AGY_FLEET_ACCOUNTS_FILE 指定），\n开发测试可用 AGY_FLEET_ACCOUNT_HOME 额外登记一个账号 HOME。\n';

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command !== 'mcp') {
        process.stderr.write(USAGE);
        process.exitCode = command === undefined || command === '--help' || command === '-h' ? 0 : 2;
        return;
    }
    const config = loadConfig();
    const manager = new TaskManager(config);
    manager.init();
    const server = createServer(manager);

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
    log.info('agy-fleet MCP 服务器已启动', { accounts: manager.accounts.list().map((a) => a.name) });
}

main().catch((err: unknown) => {
    log.error('启动失败', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
});
