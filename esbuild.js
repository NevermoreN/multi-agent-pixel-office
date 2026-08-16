const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: watch,
  minify: !watch,
};

async function build() {
  if (watch) {
    const ctx = await esbuild.context(extensionConfig);
    await ctx.watch();
    console.log('[esbuild] Watching for changes...');
  } else {
    await esbuild.build(extensionConfig);
    console.log('[esbuild] Extension built.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
