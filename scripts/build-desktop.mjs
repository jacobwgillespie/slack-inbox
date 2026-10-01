import { build } from 'esbuild'
await build({ entryPoints: ['desktop/main.ts', 'desktop/preload.ts', 'desktop/slack-preload.ts'], outdir: 'electron-dist', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' })
