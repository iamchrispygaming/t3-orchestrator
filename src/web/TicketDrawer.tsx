// The Ticket drawer: Run history (which Model Tier tried, why it failed),
// Reviews and the full live output.
import { useEffect, useRef, useState } from 'react';
import type { Ticket, TicketDetail } from '../shared/api.ts';
import { AgentIcon, Icon } from './icons.tsx';
import { api, onOutput } from './live.ts';
import { DoorTag, PrLink, StatusPill } from './TicketsPage.tsx';
import { tierLabel } from './tickets.ts';

const time = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

const RUN_OUTCOMES: Record<NonNullable<TicketDetail['runs'][number]['outcome']>, string> = {
  done: 'done',
  failed: 'failed',
  cannot: 'judged it impossible',
  'needs-permission': 'needs a permission',
};

const VERDICTS: Record<NonNullable<TicketDetail['reviews'][number]['verdict']>, string> = {
  approve: 'approved',
  'changes-needed': 'changes needed',
  unclear: 'unclear verdict',
};

function useTicketDetail(ticket: Ticket) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [output, setOutput] = useState<string[]>([]);

  // The fetch brings the output so far; lines arriving after it are appended.
  useEffect(() => {
    let loaded = false;
    const stop = onOutput((id, text) => {
      if (id === ticket.id && loaded) setOutput((lines) => [...lines, text]);
    });
    void api.getTicket(ticket.id).then((d) => {
      loaded = true;
      setDetail(d);
      setOutput(d.output);
    });
    return stop;
  }, [ticket.id]);

  // Every Ticket event replaces `ticket`: the server sends one after each state,
  // PR, Run and Review change, so refetch the Run history and Reviews on each.
  useEffect(() => {
    let current = true;
    void api.getTicket(ticket.id).then((d) => current && setDetail(d));
    return () => {
      current = false;
    };
  }, [ticket]);

  return { detail, output };
}

export function TicketDrawer({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { detail, output } = useTicketDetail(ticket);
  const term = useRef<HTMLDivElement>(null);

  useEffect(() => {
    term.current?.scrollTo({ top: term.current.scrollHeight });
  }, [output.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="fixed inset-y-0 right-0 z-50 flex w-[520px] max-w-full flex-col border-l border-line bg-[#18181b] shadow-[-30px_0_80px_#000a]">
      <div className="flex items-start gap-3 border-b border-line px-5.5 py-5">
        <AgentIcon agent={ticket.tier.agent} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-bold">{ticket.title}</div>
          <div className="text-xs text-mute">
            {ticket.repo} #{ticket.issueNumber} · {tierLabel(ticket.tier)}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <DoorTag ticket={ticket} />
            <PrLink ticket={ticket} />
          </div>
        </div>
        <StatusPill ticket={ticket} />
        <button onClick={onClose} className="ml-1 text-mute hover:text-zinc-200" aria-label="Close">
          <Icon name="close" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5.5 py-4.5">
        <section>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wider text-dim uppercase">Runs</h3>
          {detail?.runs.length ? (
            detail.runs.map((run, i) => (
              <div key={i} className="flex gap-2.5 py-1 text-sm text-zinc-300">
                <span className="font-semibold">Run {i + 1}</span>
                <span className="text-mute">{tierLabel(run.tier)}</span>
                <span className={`ml-auto text-right ${run.outcome && run.outcome !== 'done' ? 'text-red-400' : 'text-green-400'}`}>
                  {run.outcome ? RUN_OUTCOMES[run.outcome] : `running since ${time(run.startedAt)}`}
                  {run.reason && <span className="block text-xs text-zinc-400">{run.reason}</span>}
                </span>
              </div>
            ))
          ) : (
            <div className="text-sm text-dim">No Run yet.</div>
          )}
        </section>

        {detail && detail.reviews.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wider text-dim uppercase">Reviews</h3>
            {detail.reviews.map((review, i) => (
              <div key={i} className="py-1 text-sm text-zinc-300">
                <div className="flex gap-2.5">
                  <span className="font-semibold">Review {i + 1}</span>
                  <span className="text-mute">{tierLabel(review.tier)}</span>
                  <span className={`ml-auto ${review.verdict === 'approve' ? 'text-green-400' : review.verdict ? 'text-amber-300' : 'text-blue-300'}`}>
                    {review.verdict ? VERDICTS[review.verdict] : 'reviewing…'}
                  </span>
                </div>
                {review.findings && <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">{review.findings}</p>}
              </div>
            ))}
          </section>
        )}

        <div
          ref={term}
          className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-[#0c0c0e] p-3.5 font-mono text-xs leading-relaxed text-zinc-300"
        >
          {output.length === 0 ? (
            <div className="text-dim">No live output for this Ticket.</div>
          ) : (
            output.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}
