// Extension-host bundle. Webview bundles are built separately by Vite
// (webview-ui/), landing in dist/webviews/<app>/ — see P0-T9.
import esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Runtime shims (askpass, sequence editor) ship inside dist/. */
function copyShims() {
  const outDir = path.join('dist', 'shims');
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of fs.readdirSync('shims')) {
    fs.copyFileSync(path.join('shims', file), path.join(outDir, file));
  }
}

/** @type {import('esbuild').Plugin} */
const shimCopyPlugin = {
  name: 'copy-shims',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) copyShims();
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: production ? false : 'linked',
  sourcesContent: false,
  minify: production,
  logLevel: 'info',
  plugins: [shimCopyPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
