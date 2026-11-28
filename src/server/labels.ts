// The GitHub labels the Orchestrator reads on a Ticket's issue. It never writes
// status labels; the format is documented in docs/github-conventions.md.
//
//   model:<agent>:<model>/<effort>   e.g. model:claude:haiku/medium, model:codex:gpt-6.2-sol/low
//   door:one-way | door:two-way
import type { Door, ModelTier } from '../shared/api.ts';

const MODEL_LABEL = /^model:(claude|codex):(.+)\/([^/]+)$/;

export function modelLabel(tier: ModelTier): string {
  return `model:${tier.agent}:${tier.model}/${tier.effort}`;
}

// The Model Tier the labels name, or null when none, or more than one, does.
export function tierFromLabels(labels: string[]): ModelTier | null {
  const tiers = labels.flatMap((label) => {
    const match = MODEL_LABEL.exec(label.trim());
    return match ? [{ agent: match[1] as ModelTier['agent'], model: match[2]!, effort: match[3]! }] : [];
  });
  const distinct = new Set(tiers.map(modelLabel));
  return distinct.size === 1 ? tiers[0]! : null;
}

// The planned door the labels name, or null when they name none. Both labels at
// once read as one-way, the more cautious call.
export function doorFromLabels(labels: string[]): Door | null {
  const names = new Set(labels.map((l) => l.trim()));
  if (names.has('door:one-way')) return 'one-way';
  if (names.has('door:two-way')) return 'two-way';
  return null;
}
