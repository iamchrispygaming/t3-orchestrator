// Serves the built web UI (`vite build` output) from one folder, read-only.
// The UI routes by URL hash, so there is no fallback page: a missing file is a 404.
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// The file a URL path names inside `root`, or undefined when it names none.
export async function readWebFile(root: string, urlPath: string): Promise<{ body: Buffer; type: string } | undefined> {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (path.endsWith('/')) path += 'index.html';
  const base = resolve(root);
  const file = resolve(join(base, path));
  const inside = relative(base, file);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  return { body: await readFile(file), type: contentTypes[extname(file)] ?? 'application/octet-stream' };
}
