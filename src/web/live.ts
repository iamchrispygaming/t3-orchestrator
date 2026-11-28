// Live dashboard state from GET /api/events (SSE). The browser's EventSource
// reconnects by itself, and every (re)connect starts with a fresh snapshot.
import { useEffect, useState } from 'react';
import { serverEventSchema, type Ticket } from '../shared/api.ts';
import { createApiClient } from './api.ts';

export const api = createApiClient((path, init) => fetch(path, init));

// Output lines kept per Ticket for its card; the drawer fetches the full output.
const CARD_LINES = 20;

export type LiveState = {
  connected: boolean;
  tickets: Ticket[];
  output: ReadonlyMap<number, string[]>; // latest lines per Ticket id
};

type OutputListener = (ticketId: number, text: string) => void;
const outputListeners = new Set<OutputListener>();

// Every live output line, as it arrives on the dashboard's one event stream.
export function onOutput(listener: OutputListener): () => void {
  outputListeners.add(listener);
  return () => outputListeners.delete(listener);
}

export function useLive(): LiveState {
  const [state, setState] = useState<LiveState>({ connected: false, tickets: [], output: new Map() });

  useEffect(() => {
    const source = new EventSource('/api/events');
    const append = (ticketId: number, lines: string[]) =>
      setState((s) => {
        const output = new Map(s.output);
        output.set(ticketId, [...(output.get(ticketId) ?? []), ...lines].slice(-CARD_LINES));
        return { ...s, output };
      });

    const onEvent = (message: MessageEvent<string>) => {
      const event = serverEventSchema.parse(JSON.parse(message.data));
      if (event.type === 'snapshot') {
        setState({ connected: true, tickets: event.tickets, output: new Map() });
        // Cards of Tickets already working show their latest lines straight away.
        for (const ticket of event.tickets.filter((t) => t.state === 'running' || t.state === 'reviewing')) {
          void api.getTicket(ticket.id).then((detail) => append(ticket.id, detail.output.slice(-CARD_LINES)));
        }
      } else if (event.type === 'ticket') {
        setState((s) => {
          const known = s.tickets.some((t) => t.id === event.ticket.id);
          const tickets = known
            ? s.tickets.map((t) => (t.id === event.ticket.id ? event.ticket : t))
            : [...s.tickets, event.ticket];
          return { ...s, tickets };
        });
      } else if (event.type === 'output') {
        append(event.ticketId, [event.text]);
        for (const listener of outputListeners) listener(event.ticketId, event.text);
      }
    };

    // Plan events are for the Planner page (#49).
    for (const type of ['snapshot', 'ticket', 'output']) source.addEventListener(type, onEvent);
    source.onerror = () => setState((s) => ({ ...s, connected: false }));
    return () => source.close();
  }, []);

  return state;
}
