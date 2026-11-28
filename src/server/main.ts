// The real process: serves the API and the built web UI on 127.0.0.1.
// `npm start` builds the UI first (scripts/start.ts); `npm run dev` runs this
// with `--watch` next to Vite's dev server (scripts/dev.ts).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createServer } from './server.ts';
import { unwiredAgentRunner, unwiredGitHub } from './unwired.ts';

export const DEFAULT_PORT = 4317;
export const WEB_ROOT = fileURLToPath(new URL('../../dist/web', import.meta.url));

export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

export function startOrchestrator({ open }: { open: boolean }): void {
  const port = Number(process.env.T3O_PORT ?? DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}/`;
  const server = createServer({
    env: process.env,
    github: unwiredGitHub,
    agentRunner: unwiredAgentRunner,
    webRoot: WEB_ROOT,
    port,
    // `npm run dev` names Vite's dev server, whose proxy forwards the browser's Origin.
    devOrigins: process.env.T3O_DEV_ORIGINS?.split(',').filter(Boolean),
  });
  const http = serve({ fetch: server.app.fetch, hostname: '127.0.0.1', port }, () => {
    console.log(`T3 Orchestrator is running at ${url}  (Ctrl+C stops it)`);
    if (open) openBrowser(url);
  });
  http.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') throw error;
    console.log(`Port ${port} is in use: the Orchestrator may already be running at ${url}`);
    if (open) openBrowser(url);
    void server.close().then(() => process.exit(1));
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => http.close(() => process.exit(0)));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.main) startOrchestrator({ open: process.env.T3O_NO_OPEN !== '1' });
