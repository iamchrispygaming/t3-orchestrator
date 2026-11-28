// The Tickets page: a card grid, cards needing the user first.
import { useEffect, useRef, useState } from 'react';
import { agentSchema, ticketStateSchema, type ListTicketsQuery, type Ticket } from '../shared/api.ts';
import { AgentIcon, Icon } from './icons.tsx';
import { api } from './live.ts';
import { actionsFor, AGENT_NAMES, cardOrder, needsYou, prUrl, STATE_LABELS, STATE_STYLES, tierLabel } from './tickets.ts';

export function StatusPill({ ticket }: { ticket: Ticket }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_STYLES[ticket.state]}`}
    >
      <i className={`size-1.5 rounded-full bg-current ${ticket.state === 'running' ? 'blink' : ''}`} />
      {STATE_LABELS[ticket.state]}
    </span>
  );
}

export function DoorTag({ ticket }: { ticket: Ticket }) {
  const style = ticket.door === 'one-way' ? 'bg-amber-500/15 text-amber-300' : 'bg-zinc-700/60 text-zinc-300';
  return <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${style}`}>{ticket.door}</span>;
}

export function PrLink({ ticket }: { ticket: Ticket }) {
  const url = prUrl(ticket);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-md bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-300 hover:underline"
    >
      <Icon name="pr" className="size-3.5" />
      PR #{ticket.prNumber}
    </a>
  );
}

function TicketCard({
  ticket,
  lines,
  selected,
  onOpen,
}: {
  ticket: Ticket;
  lines: string[];
  selected: boolean;
  onOpen: () => void;
}) {
  const working = ticket.state === 'running' || ticket.state === 'reviewing';
  const actions = actionsFor(ticket);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      className={`flex cursor-pointer flex-col gap-4 rounded-xl border-[1.5px] bg-card p-5 transition hover:border-zinc-600 ${
        selected ? 'border-blue-500 ring-3 ring-blue-500/15' : needsYou(ticket) ? 'border-red-500/40' : 'border-line'
      }`}
    >
      <div className="flex items-start gap-3">
        <AgentIcon agent={ticket.tier.agent} />
        <div className="min-w-0">
          <div className="text-base leading-snug font-bold">{ticket.title}</div>
          <div className="mt-0.5 text-xs text-mute">
            {ticket.repo} #{ticket.issueNumber} · {tierLabel(ticket.tier)}
          </div>
        </div>
        <span className="ml-auto">
          <StatusPill ticket={ticket} />
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <DoorTag ticket={ticket} />
        <PrLink ticket={ticket} />
      </div>

      {working && (
        <div className="h-11 overflow-hidden rounded-lg bg-[#0c0c0e] px-2.5 py-2 font-mono text-xs leading-relaxed text-zinc-300">
          {lines.slice(-2).map((line, i) => (
            <div key={i} className="truncate">
              {line}
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center gap-4 border-t border-line pt-3.5 text-sm font-semibold">
        <span className="inline-flex items-center gap-1.5 text-zinc-300">
          <Icon name="term" />
          Output
        </span>
        {actions.map((action) => (
          <button
            key={action.label}
            onClick={(e) => {
              e.stopPropagation();
              void action.run();
            }}
            className="rounded-md border border-line2 px-2.5 py-1 text-xs"
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type TicketResults = { tickets: Ticket[]; failed?: boolean };

function useTicketResults(
  query: ListTicketsQuery,
  active: boolean,
  tickets: Ticket[],
  output: ReadonlyMap<number, string[]>,
): TicketResults | undefined {
  const [results, setResults] = useState<TicketResults & { query: ListTicketsQuery }>();
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let pending = false;

    function schedule() {
      if (controller.signal.aborted || timer !== undefined) return;
      if (running) {
        pending = true;
        return;
      }
      // Coalesce SSE bursts and typing without waiting for live output to stop.
      timer = setTimeout(load, 250);
    }

    async function load() {
      timer = undefined;
      running = true;
      try {
        const tickets = await api.listTickets(query, controller.signal);
        if (!controller.signal.aborted) setResults({ query, tickets });
      } catch {
        if (!controller.signal.aborted) setResults({ query, tickets: [], failed: true });
      } finally {
        running = false;
        if (pending) {
          pending = false;
          schedule();
        }
      }
    }

    refresh.current = schedule;
    schedule();
    return () => {
      refresh.current = () => {};
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, query]);

  useEffect(() => refresh.current(), [tickets]);
  useEffect(() => {
    if (query.q?.trim()) refresh.current();
  }, [output, query.q]);

  if (!active) return { tickets };
  return results?.query === query ? results : undefined;
}

export function TicketsPage({
  tickets,
  output,
  selectedId,
  onOpen,
}: {
  tickets: Ticket[];
  output: ReadonlyMap<number, string[]>;
  selectedId: number | null;
  onOpen: (id: number) => void;
}) {
  const [query, setQuery] = useState<ListTicketsQuery>({});
  const filtered = Boolean(query.state || query.agent || query.repoId || query.q?.trim());
  const results = useTicketResults(query, filtered, tickets, output);
  const projects = [...new Map(tickets.map((ticket) => [ticket.repoId, ticket.repo]))]
    .sort(([, a], [, b]) => a.localeCompare(b));
  const field = 'rounded-md border border-line2 bg-panel px-3 py-2 text-sm text-zinc-200';

  return (
    <>
      <div className="mb-5 flex flex-wrap gap-3">
        <input
          type="search"
          aria-label="Search Tickets, PRs and Agent output"
          placeholder="Search Tickets, PRs and Agent output"
          className={`${field} min-w-56 flex-1`}
          value={query.q ?? ''}
          onChange={(event) => {
            const q = event.currentTarget.value;
            setQuery((previous) => ({ ...previous, q }));
          }}
        />
        <select
          aria-label="Status"
          className={field}
          value={query.state ?? ''}
          onChange={(event) => {
            const state = ticketStateSchema.safeParse(event.currentTarget.value).data;
            setQuery((previous) => ({ ...previous, state }));
          }}
        >
          <option value="">All statuses</option>
          {ticketStateSchema.options.map((state) => <option key={state} value={state}>{STATE_LABELS[state]}</option>)}
        </select>
        <select
          aria-label="Agent"
          className={field}
          value={query.agent ?? ''}
          onChange={(event) => {
            const agent = agentSchema.safeParse(event.currentTarget.value).data;
            setQuery((previous) => ({ ...previous, agent }));
          }}
        >
          <option value="">All Agents</option>
          {agentSchema.options.map((agent) => <option key={agent} value={agent}>{AGENT_NAMES[agent]}</option>)}
        </select>
        <select
          aria-label="Project"
          className={field}
          value={query.repoId ?? ''}
          onChange={(event) => {
            const repoId = Number(event.currentTarget.value) || undefined;
            setQuery((previous) => ({ ...previous, repoId }));
          }}
        >
          <option value="">All projects</option>
          {projects.map(([id, repo]) => <option key={id} value={id}>{repo}</option>)}
        </select>
      </div>
      {!results ? (
        <p role="status" className="text-sm text-mute">Loading Tickets…</p>
      ) : results.failed ? (
        <p role="alert" className="text-sm text-red-400">Couldn’t load Tickets.</p>
      ) : results.tickets.length === 0 ? (
        <p role="status" className="py-8 text-center text-mute">
          {filtered ? 'No Tickets match your search or filters.' : 'Tickets appear here once a Plan is approved.'}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4.5">
          {cardOrder(results.tickets).map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              lines={output.get(ticket.id) ?? []}
              selected={ticket.id === selectedId}
              onOpen={() => onOpen(ticket.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}
