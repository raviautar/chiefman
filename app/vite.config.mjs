import { fileURLToPath } from 'node:url';

// The root is this folder, so the dev server and the build work from anywhere.
const root = fileURLToPath(new URL('.', import.meta.url));

export default {
  root,
  base: './',
  server: { host: '127.0.0.1', port: 5199, strictPort: false },
  build: { outDir: 'dist', emptyOutDir: true },
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
};
