// The Ladder: Model Tiers ordered least to most capable. Routing moves up it to
// the other Agent when an Agent is near its quota limit.
import type { Agent, ModelTier } from '../shared/api.ts';

export const DEFAULT_LADDER: ModelTier[] = [
  { agent: 'claude', model: 'haiku', effort: 'medium' },
  { agent: 'codex', model: 'gpt-6.2-sol', effort: 'low' },
  { agent: 'claude', model: 'sonnet', effort: 'medium' },
  { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' },
  { agent: 'claude', model: 'opus', effort: 'high' },
  { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' },
];

export function tierLabel(tier: ModelTier): string {
  return `${tier.agent}:${tier.model}/${tier.effort}`;
}

// The first Model Tier of `agent` above `tier` on the Ladder, or undefined when
// there is none (or `tier` is not on the Ladder).
export function nextTierOf(ladder: ModelTier[], tier: ModelTier, agent: Agent): ModelTier | undefined {
  const at = ladder.findIndex((t) => tierLabel(t) === tierLabel(tier));
  return at < 0 ? undefined : ladder.slice(at + 1).find((t) => t.agent === agent);
}

export const otherAgent = (agent: Agent): Agent => (agent === 'claude' ? 'codex' : 'claude');
