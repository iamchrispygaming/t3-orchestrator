// The dashboard shell: nav rail with the Needs-you count, the page, and the
// Ticket drawer. Routes live in the URL hash (#/tickets, #/tickets/12, ...).
// Closing the tab stops nothing: the server owns all work.
import { useCallback, useEffect, useState } from 'react';
import { Icon, type IconName } from './icons.tsx';
import { useLive } from './live.ts';
import { TicketDrawer } from './TicketDrawer.tsx';
import { TicketsPage } from './TicketsPage.tsx';
import { needsYou } from './tickets.ts';

const PAGES = [
  { id: 'home', label: 'Home', icon: 'home', comesWith: '#47' },
  { id: 'tickets', label: 'Tickets', icon: 'ticket' },
  { id: 'agents', label: 'Agents', icon: 'bot', comesWith: '#48' },
  { id: 'planner', label: 'Planner', icon: 'chat', comesWith: '#49' },
  { id: 'activity', label: 'Activity', icon: 'pulse', comesWith: '#47' },
  { id: 'settings', label: 'Settings', icon: 'gear', comesWith: '#48' },
] as const satisfies readonly { id: string; label: string; icon: IconName; comesWith?: string }[];

type PageId = (typeof PAGES)[number]['id'];
type Route = { page: PageId; ticketId: number | null };

function parseRoute(hash: string): Route {
  const [, page, id] = hash.split('/');
  const known = PAGES.find((p) => p.id === page);
  return { page: known?.id ?? 'tickets', ticketId: known?.id === 'tickets' && id ? Number(id) : null };
}

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return [route, (hash) => (location.hash = hash)];
}

// The tab shows the Needs-you count in its title and as a dot on the favicon.
function useTabBadge(count: number): void {
  useEffect(() => {
    document.title = count > 0 ? `(${count}) T3 Orchestrator` : 'T3 Orchestrator';
    const dot = count > 0 ? '<circle cx="25" cy="7" r="7" fill="#ef4444"/>' : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="4" width="26" height="26" rx="7" fill="#3b82f6"/>${dot}</svg>`;
    const link = document.getElementById('favicon') as HTMLLinkElement | null;
    if (link) link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }, [count]);
}

export function App() {
  const live = useLive();
  const [route, go] = useRoute();
  const needsYouCount = live.tickets.filter(needsYou).length;
  useTabBadge(needsYouCount);

  const open = live.tickets.find((t) => t.id === route.ticketId) ?? null;
  const close = useCallback(() => go('#/tickets'), [go]);
  const page = PAGES.find((p) => p.id === route.page)!;

  return (
    <div className="grid h-full grid-cols-[208px_1fr] grid-rows-[60px_1fr]">
      <nav className="row-span-2 flex flex-col gap-1 border-r border-line bg-panel px-3.5 py-4.5">
        <div className="flex items-center gap-2.5 px-2 pb-5.5 text-lg font-extrabold">
          <b className="size-5 rounded bg-white [clip-path:polygon(0_0,60%_0,60%_40%,100%_40%,100%_100%,40%_100%,40%_60%,0_60%)]" />
          Orchestrator
        </div>
        {PAGES.map((p) => (
          <a
            key={p.id}
            href={`#/${p.id}`}
            className={`flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-semibold ${
              p.id === route.page ? 'bg-blue-900/40 text-blue-400 shadow-[inset_3px_0_0_#3b82f6]' : 'text-zinc-300'
            } ${p.id === 'settings' ? 'mt-auto' : ''}`}
          >
            <Icon name={p.icon} />
            {p.label}
            {p.id === 'tickets' && needsYouCount > 0 && (
              <span className="ml-auto rounded-full bg-red-500 px-1.5 text-[11px] text-white" title="Needs you">
                {needsYouCount}
              </span>
            )}
          </a>
        ))}
      </nav>

      <header className="flex items-center gap-4 border-b border-line px-8">
        <h1 className="text-lg font-bold">{page.label}</h1>
        {needsYouCount > 0 && <span className="text-sm text-red-400">{needsYouCount} need you</span>}
        <span className={`ml-auto flex items-center gap-2 text-xs ${live.connected ? 'text-green-400' : 'text-amber-300'}`}>
          <i className="size-1.5 rounded-full bg-current" />
          {live.connected ? 'Live' : 'Reconnecting…'}
        </span>
      </header>

      <main className="overflow-auto px-6 pt-6.5 pb-20">
        {page.id === 'tickets' ? (
          <TicketsPage
            tickets={live.tickets}
            output={live.output}
            selectedId={route.ticketId}
            onOpen={(id) => go(`#/tickets/${id}`)}
          />
        ) : (
          <div className="grid h-full place-items-center text-mute">The {page.label} page comes with {page.comesWith}.</div>
        )}
      </main>

      {open && route.page === 'tickets' && <TicketDrawer ticket={open} onClose={close} />}
    </div>
  );
}
