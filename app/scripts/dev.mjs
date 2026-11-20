// Starts the Vite dev server on 127.0.0.1 and Electron on top of it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer({ configFile: new URL('../vite.config.mjs', import.meta.url).pathname });
await server.listen();
const url = server.resolvedUrls.local[0];
const root = new URL('..', import.meta.url).pathname;
const child = spawn(electron, [root], { cwd: root, stdio: 'inherit', env: { ...process.env, CHIEFMAN_DEV_URL: url } });
const stop = async (code) => {
  await server.close();
  process.exit(code ?? 0);
};
child.on('exit', stop);
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
