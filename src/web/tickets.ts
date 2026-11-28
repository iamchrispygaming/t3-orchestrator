// How the UI presents a Ticket: its status pill, whether it needs the user,
// card order and the actions its card offers.
import type { ModelTier, Ticket, TicketState } from '../shared/api.ts';

export const STATE_LABELS: Record<TicketState, string> = {
  waiting: 'Waiting',
  ready: 'Up next',
  running: 'Running',
  reviewing: 'In review',
  'awaiting-merge': 'Awaiting merge',
  merged: 'Merged',
  handback: 'Handed back',
};

export const STATE_STYLES: Record<TicketState, string> = {
  waiting: 'text-amber-300 bg-amber-400/10',
  ready: 'text-zinc-400 bg-white/5',
  running: 'text-green-400 bg-green-500/10',
  reviewing: 'text-blue-400 bg-blue-500/10',
  'awaiting-merge': 'text-red-300 bg-red-400/10',
  merged: 'text-violet-300 bg-violet-400/10',
  handback: 'text-red-300 bg-red-400/10',
};

// States where the Orchestrator waits for the user: Handback, and Awaiting merge
// (the merge Checkpoint).
const NEEDS_YOU: ReadonlySet<TicketState> = new Set<TicketState>(['handback', 'awaiting-merge']);

export function needsYou(ticket: Ticket): boolean {
  return NEEDS_YOU.has(ticket.state);
}

const ORDER: TicketState[] = ['handback', 'awaiting-merge', 'reviewing', 'running', 'ready', 'waiting', 'merged'];

// Cards needing the user first, then the rest by how far along they are.
export function cardOrder(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort(
    (a, b) =>
      Number(needsYou(b)) - Number(needsYou(a)) ||
      ORDER.indexOf(a.state) - ORDER.indexOf(b.state) ||
      a.id - b.id,
  );
}

export const AGENT_NAMES: Record<ModelTier['agent'], string> = { claude: 'Claude Code', codex: 'Codex' };

export function tierLabel(tier: ModelTier): string {
  return `${AGENT_NAMES[tier.agent]} · ${tier.model} / ${tier.effort}`;
}

export function prUrl(ticket: Ticket): string | null {
  return ticket.prNumber == null ? null : `https://github.com/${ticket.repo}/pull/${ticket.prNumber}`;
}

export type CardAction = { label: string; run: () => Promise<unknown> };

// The actions a card offers in each state, each one an API call. The API has
// none yet: merge, request changes, retry, take over, stop and resume arrive
// with #28, #29, #30 and #33, and their buttons with them.
export function actionsFor(_ticket: Ticket): CardAction[] {
  return [];
}
