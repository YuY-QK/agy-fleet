import { defineConfig } from 'tsdown';

// 发布物自包含：运行时库放在 devDependencies，由 tsdown 打进产物。
export default defineConfig({
    entry: ['src/cli.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: true,
    fixedExtension: false,
});
