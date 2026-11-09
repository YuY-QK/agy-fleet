#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { createServer } from './mcp/server.ts';

const USAGE =
    '用法：agy-fleet mcp    以 stdio 方式启动 MCP 服务器\n需要环境变量 AGY_FLEET_ACCOUNT_HOME（账号的独立 HOME）。\n';

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command !== 'mcp') {
        process.stderr.write(USAGE);
        process.exitCode = command === undefined || command === '--help' || command === '-h' ? 0 : 2;
        return;
    }
    const config = loadConfig();
    const server = createServer(config);
    await server.connect(new StdioServerTransport());
    log.info('agy-fleet MCP 服务器已启动', { account: config.accountName });
}

main().catch((err: unknown) => {
    log.error('启动失败', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
});
