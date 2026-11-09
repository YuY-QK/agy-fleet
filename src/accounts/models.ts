import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FleetError } from '../errors.ts';
import { unlockAccountKeychain } from './credStore.ts';

const execFileAsync = promisify(execFile);

export interface ModelInfo {
    id: string;
    name: string;
}

/** 解析 `agy models` 的输出：每行 `<id>\t<显示名>`，其余行（如“Fetching…”）忽略。 */
export function parseModelList(output: string): ModelInfo[] {
    const models: ModelInfo[] = [];
    for (const line of output.split('\n')) {
        const [id, name] = line.split('\t');
        if (id !== undefined && id.trim() !== '' && name !== undefined) {
            models.push({ id: id.trim(), name: name.trim() });
        }
    }
    return models;
}

/** 用某个账号的身份执行 `agy models`。 */
export async function listModels(agyBin: string, accountHome: string): Promise<ModelInfo[]> {
    await unlockAccountKeychain(accountHome);
    try {
        const { stdout } = await execFileAsync(agyBin, ['models'], {
            env: { ...process.env, HOME: accountHome },
            timeout: 30_000,
        });
        return parseModelList(stdout);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new FleetError('agy_not_found', `找不到可执行文件：${agyBin}`);
        throw new FleetError('agent_crashed', `${agyBin} models 失败：${String(err)}`);
    }
}
