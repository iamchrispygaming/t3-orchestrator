// The Ladder: Model Tiers ordered least to most capable. Escalation climbs it.
import type { EscalationSettings, ModelTier } from '../shared/api.ts';

export const DEFAULT_LADDER: ModelTier[] = [
  { agent: 'claude', model: 'haiku', effort: 'medium' },
  { agent: 'codex', model: 'gpt-6.2-sol', effort: 'low' },
  { agent: 'claude', model: 'sonnet', effort: 'medium' },
  { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' },
  { agent: 'claude', model: 'opus', effort: 'high' },
  { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' },
];

export const DEFAULT_ESCALATION_SETTINGS: EscalationSettings ={ ladder: DEFAULT_LADDER, runTimeLimitMinutes: 60 };

export function tierLabel(tier: ModelTier): string {
  return `${tier.agent}:${tier.model}/${tier.effort}`;
}

// The next more capable Model Tier, or undefined at the top. A tier that is not
// on the Ladder (it was edited away) has nowhere to climb to either.
export function nextTier(ladder: ModelTier[], tier: ModelTier): ModelTier | undefined {
  const at = ladder.findIndex((t) => tierLabel(t) === tierLabel(tier));
  return at < 0 ? undefined : ladder[at + 1];
}
