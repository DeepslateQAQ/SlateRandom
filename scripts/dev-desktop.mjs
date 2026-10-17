import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const server = await createServer({
  configFile: path.join(root, 'vite.config.mts'),
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
});
await server.listen();
const devUrl = server.resolvedUrls?.local?.[0];
if (!devUrl) throw new Error('Vite did not expose a local development URL.');
server.printUrls();

const executable = require('electron');
const child = spawn(executable, [root, ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, SLATE_DEV_URL: devUrl },
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill();
  await server.close();
  process.exitCode = code;
}
child.once('error', error => {
  console.error(error.message);
  void stop(1);
});
child.once('exit', code => { void stop(code ?? 0); });
process.once('SIGINT', () => { void stop(0); });
process.once('SIGTERM', () => { void stop(0); });
