// Typed client for the Orchestrator's API, used by the web UI (and the tests).
// `fetchFn` is the browser's fetch, or the server's in-process handler.
import {
  serverEventSchema,
  targetRepoSchema,
  ticketDetailSchema,
  ticketSchema,
  type AddTargetRepoRequest,
  type RegisterTicketRequest,
  type ServerEvent,
} from '../shared/api.ts';

export type FetchFn = (path: string, init?: RequestInit) => Promise<Response>;

export type EventStream = {
  next(): Promise<ServerEvent>;
  close(): Promise<void>;
};

export function createApiClient(fetchFn: FetchFn) {
  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetchFn(path, init);
    const body: unknown = await res.json();
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed (${res.status}): ${JSON.stringify(body)}`);
    return body;
  }
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return {
    async addTargetRepo(req: AddTargetRepoRequest) {
      return targetRepoSchema.parse(await post('/api/repos', req));
    },
    async registerTicket(req: RegisterTicketRequest) {
      return ticketSchema.parse(await post('/api/tickets', req));
    },
    async getTicket(id: number) {
      return ticketDetailSchema.parse(await call(`/api/tickets/${id}`));
    },
    async events(): Promise<EventStream> {
      const res = await fetchFn('/api/events', { headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`GET /api/events failed (${res.status})`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      return {
        async next() {
          for (;;) {
            const end = buffer.indexOf('\n\n');
            if (end >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (data !== '') return serverEventSchema.parse(JSON.parse(data));
              continue;
            }
            const { value, done } = await reader.read();
            if (done) throw new Error('event stream ended');
            buffer += value.replace(/\r\n/g, '\n');
          }
        },
        async close() {
          await reader.cancel();
        },
      };
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
