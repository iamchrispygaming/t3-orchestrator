// `npm run dev`: the server under `node --watch`, and Vite's dev server with hot
// reload in front of it (it proxies /api to the server).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

const api = spawn(process.execPath, ['--watch', join(root, 'src/server/main.ts')], {
  stdio: 'inherit',
  env: { ...process.env, T3O_NO_OPEN: '1' },
});

const vite = await createServer({ configFile: join(root, 'vite.config.ts'), server: { open: true } });
await vite.listen();
vite.printUrls();

const stop = () => {
  api.kill();
  void vite.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
