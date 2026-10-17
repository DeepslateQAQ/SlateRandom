import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

const root = fileURLToPath(new URL('.', import.meta.url));

function canonicalEngineForDev(): Plugin {
  const enginePath = normalizePath(resolve(root, 'src/shared/domain/engine.js'));
  return {
    name: 'rollcall:canonical-engine-dev-module',
    apply: 'serve',
    enforce: 'pre',
    handleHotUpdate({ file, server }) {
      const changed = normalizePath(file), frontend = normalizePath(resolve(root, 'src/renderer')) + '/';
      const native = normalizePath(resolve(root, 'src/shared')) + '/';
      // Native actors retain DOM references and listeners; scripts start one
      // fresh controller on reload. CSS continues to use Vite hot updates.
      if ((changed.startsWith(frontend) && /\.(?:vue|[cm]?js|ts)$/.test(changed) && !/\.test\.ts$/.test(changed)) ||
          (changed.startsWith(native) && changed.endsWith('.js'))) {
        server.ws.send({ type: 'full-reload', path: '*' });
        return [];
      }
    },
    transform(source, id) {
      if (normalizePath(id.split('?')[0]) !== enginePath) return;
      // Development serves relative modules directly, so build's CommonJS
      // conversion cannot provide this import's default export. Remove only
      // the known UMD shell; the original factory body remains byte-for-byte.
      const prefix = /^\(function \(root, factory\) \{\r?\n  const api = factory\(\);\r?\n  if \(typeof module === 'object' && module\.exports\) module\.exports = api;\r?\n  else root\.DrawCore = api;\r?\n\}\)\(typeof globalThis !== 'undefined' \? globalThis : this, function \(\) \{\r?\n/.exec(source);
      const suffix = /\r?\n\}\);\s*$/.exec(source);
      if (!prefix || !suffix || prefix[0].length >= suffix.index) {
        this.error('Canonical engine UMD wrapper changed; update the precise development adapter.');
      }
      const factory = source.slice(prefix[0].length, suffix.index);
      return { code: 'const canonicalEngine = (() => {\n' + factory + '\n})();\nexport default canonicalEngine;\n', map: null };
    }
  };
}

export default defineConfig(({ command }) => ({
  root,
  base: './',
  publicDir: false,
  plugins: [vue(), ...(command === 'serve' ? [canonicalEngineForDev()] : [])],
  ...(command === 'serve' ? { optimizeDeps: { entries: ['src/renderer/main.ts'] } } : {}),
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    'process.env.NODE_ENV': JSON.stringify(command === 'build' ? 'production' : 'development')
  },
  build: {
    outDir: resolve(root, '.vite-build'),
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    sourcemap: false,
    license: { fileName: 'dependency-licenses.json' },
    lib: {
      entry: resolve(root, 'src/renderer/main.ts'),
      name: 'SlateRandom',
      formats: ['iife'],
      fileName: () => 'rollcall.js',
      cssFileName: 'rollcall'
    },
    // Convert the canonical UMD engine and installed dependencies only. Other
    // browser adapters deliberately publish their existing window APIs.
    commonjsOptions: {
      include: [/node_modules/, /[\\/]src[\\/]shared[\\/]domain[\\/]engine\.js$/]
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    },
    chunkSizeWarningLimit: 1600
  }
}));
