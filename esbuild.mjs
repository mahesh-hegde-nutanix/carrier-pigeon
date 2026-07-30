import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
    bundle: true,
    minify: production,
    sourcemap: !production,
    logLevel: 'info'
};

/** @type {import('esbuild').BuildOptions} */
const hostConfig = {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode']
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife'
};

async function main() {
    if (watch) {
        const contexts = await Promise.all([
            esbuild.context(hostConfig),
            esbuild.context(webviewConfig)
        ]);
        await Promise.all(contexts.map(c => c.watch()));
    } else {
        await Promise.all([esbuild.build(hostConfig), esbuild.build(webviewConfig)]);
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
