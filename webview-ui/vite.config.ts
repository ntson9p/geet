import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import { defineConfig } from 'vite';

/**
 * Multi-entry webview build (master §9): one entry per app, output
 * dist/webviews/<app>/{index.js,index.css} at the repository root so the
 * extension bundle ships them. `base: './'` keeps all asset URLs relative —
 * required for vscode-webview resource URIs. No CDN resources, ever.
 */
const apps: Record<string, string> = {
  commit: path.resolve(__dirname, 'src/commit/main.tsx'),
  demo: path.resolve(__dirname, 'src/demo/main.tsx'),
  dialogs: path.resolve(__dirname, 'src/dialogs/main.tsx'),
  log: path.resolve(__dirname, 'src/log/main.tsx'),
  rebase: path.resolve(__dirname, 'src/rebase/main.tsx'),
  // pr:     added in P8
  // NOTE: `kit` is deliberately absent — kit.html is a dev/Playwright harness
  // for the P11-T1 shared components and must never enter dist/webviews.
};

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../dist/webviews'),
    emptyOutDir: true,
    cssCodeSplit: true,
    sourcemap: false,
    rollupOptions: {
      input: apps,
      output: {
        entryFileNames: '[name]/index.js',
        chunkFileNames: 'shared/[name]-[hash].js',
        assetFileNames: (info) => {
          const name = info.names[0] ?? 'asset';
          // Entry CSS lands next to its entry as index.css.
          if (name.endsWith('.css')) {
            const app = name.replace(/\.css$/, '');
            if (app in apps) return `${app}/index.css`;
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  server: {
    // Explicit IPv4: `localhost` may resolve to ::1 while the Playwright
    // webServer probe targets 127.0.0.1.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
