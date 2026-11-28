// Keeps the API to the dashboard. The server listens on 127.0.0.1, so any web
// page the user visits can aim requests at it: a hostile domain re-resolved to
// 127.0.0.1 (DNS rebinding) arrives with its own Host, and a plain cross-site
// request (no preflight) arrives with the other site's Origin.
import type { MiddlewareHandler } from 'hono';

export type LocalGuardOptions = {
  // The port the server listens on; none for in-process requests to http://localhost/.
  port?: number;
  // Other origins the dashboard is served from: the Vite dev server under `npm run dev`.
  devOrigins?: string[];
};

export function localGuard({ port, devOrigins = [] }: LocalGuardOptions): MiddlewareHandler {
  const suffix = port === undefined || port === 80 ? '' : `:${port}`; // a URL drops the default port
  const hosts = new Set(['127.0.0.1', 'localhost'].map((name) => name + suffix));
  const origins = new Set([...[...hosts].map((host) => `http://${host}`), ...devOrigins]);

  return async (c, next) => {
    // @hono/node-server builds the request URL from the Host header.
    if (!hosts.has(new URL(c.req.url).host)) return c.json({ error: 'refused: unknown Host' }, 403);
    // Browsers send Origin on every cross-site request that could change state;
    // tools like curl send none.
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.has(origin)) return c.json({ error: 'refused: foreign Origin' }, 403);
    await next();
  };
}

export class NotJson extends Error {
  constructor() {
    super('refused: the body must be sent as Content-Type: application/json');
  }
}

export function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}
