// `npm run dev`: the server under `node --watch`, and Vite's dev server with hot
// reload in front of it (it proxies /api to the server).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

const vite = await createServer({ configFile: join(root, 'vite.config.ts'), server: { open: true } });
await vite.listen();
vite.printUrls();

// The server refuses any Origin but its own, so it is told Vite's (known once it listens).
const address = vite.httpServer?.address();
const vitePort = typeof address === 'object' && address ? address.port : 5173;
const devOrigins = ['127.0.0.1', 'localhost'].map((host) => `http://${host}:${vitePort}`).join(',');

const api = spawn(process.execPath, ['--watch', join(root, 'src/server/main.ts')], {
  stdio: 'inherit',
  env: { ...process.env, T3O_NO_OPEN: '1', T3O_DEV_ORIGINS: devOrigins },
});

const stop = () => {
  api.kill();
  void vite.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
