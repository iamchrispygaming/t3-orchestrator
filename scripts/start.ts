// `npm start`: builds the web UI when it is missing or older than its sources,
// then starts the Orchestrator and opens the dashboard.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOrchestrator, WEB_ROOT } from '../src/server/main.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sources = ['src/web', 'src/shared', 'vite.config.ts', 'package-lock.json'].map((p) => join(root, p));

function newestChange(path: string): number {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) return 0;
  if (!info.isDirectory()) return info.mtimeMs;
  return Math.max(info.mtimeMs, ...readdirSync(path).map((entry) => newestChange(join(path, entry))));
}

const built = statSync(join(WEB_ROOT, 'index.html'), { throwIfNoEntry: false })?.mtimeMs ?? 0;
if (built < Math.max(...sources.map(newestChange))) {
  console.log('Building the dashboard…');
  const { build } = await import('vite');
  await build({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
}

startOrchestrator({ open: process.env.T3O_NO_OPEN !== '1' });
