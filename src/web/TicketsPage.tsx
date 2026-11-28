// The Tickets page: a card grid, cards needing the user first.
import type { Ticket } from '../shared/api.ts';
import { AgentIcon, Icon } from './icons.tsx';
import { actionsFor, cardOrder, needsYou, prUrl, STATE_LABELS, STATE_STYLES, tierLabel } from './tickets.ts';

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
  if (tickets.length === 0) {
    return (
      <div className="grid h-full place-items-center text-center text-mute">
        <div>
          <div className="text-base font-semibold text-zinc-300">No Tickets yet</div>
          <div className="mt-1 text-sm">Tickets appear here once a Plan is approved.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4.5">
      {cardOrder(tickets).map((ticket) => (
        <TicketCard
          key={ticket.id}
          ticket={ticket}
          lines={output.get(ticket.id) ?? []}
          selected={ticket.id === selectedId}
          onOpen={() => onOpen(ticket.id)}
        />
      ))}
    </div>
  );
}
