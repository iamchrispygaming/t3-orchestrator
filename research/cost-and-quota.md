# How can the Orchestrator measure Cost and subscription quota?

Research for issue #4. All sources retrieved **2026-11-25**. Prices are USD per million tokens (MTok) and change often, so the Orchestrator should keep them in an editable price table, not hard-code them.

## TL;DR

- **After a run, Claude Code reports a dollar estimate itself.** `claude -p --output-format json` (or `stream-json`) ends with a `result` message carrying `total_cost_usd` and a per-model `modelUsage` map with token counts and `costUSD`. It is a client-side estimate at list price.
- **Codex reports tokens, not dollars.** `codex exec --json` emits `turn.completed` events with `usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`). The Orchestrator multiplies these by its own OpenAI price table.
- **Before a run, there is no exact answer.** Agent runs are multi-turn, so the opening prompt is a small share of the total. Both vendors offer free input-token counting endpoints, but the useful estimate is *historical*: median tokens per (Agent, Model Tier, ticket size) from past runs, times the price table. Claude Code can also enforce a hard ceiling with `--max-budget-usd`.
- **Codex subscription quota is readable programmatically, officially.** `codex app-server` exposes `account/rateLimits/read`, which returns the 5-hour (`primary`) and weekly (`secondary`) windows as `usedPercent` + `resetsAt`, plus credits and plan type, and pushes `account/rateLimits/updated` notifications.
- **Claude subscription quota is readable only from inside a running session.** The status line JSON has `rate_limits.five_hour` / `seven_day` `used_percentage` + `resets_at` (Pro/Max/Ultra only), and the SDK / stream-json emits `rate_limit_event` with `status` (`allowed` / `allowed_warning` / `rejected`), `utilization` and `resetsAt`. There is no documented standalone "read my remaining quota" endpoint.
- **Subscription runs are "free" but Claude Code still reports a notional `total_cost_usd`.** That is useful as an "API-equivalent cost" to show savings, but must not be counted as spend.

## 1. Current per-model prices

### Claude (Anthropic API)

Source: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

| Model | Input | 5m cache write | 1h cache write | Cache read | Output |
|---|---|---|---|---|---|
| Claude Fable 5.2 | $8 | $10 | $16 | $0.20 | $40 |
| Claude Fable 5.1 | $10 | $12.50 | $20 | $0.25 | $50 |
| Claude Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Sonnet 5.5 | $2 | $2.50 | $4 | $0.10 | $10 |
| Claude Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Claude Sonnet 4.6 / 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Haiku 5.5 (prompt ≤100k) | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
| Claude Haiku 5.5 (prompt >100k) | $0.50 | $0.625 | $1 | $0.05 | $2.50 |
| Claude Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |

Modifiers that matter for a cost calculator (same source):

- Cache read is 0.1x input on most models, but 0.05x on Opus 5.5 / Sonnet 5.5 and 0.025x on Fable 5.1 / 5.2.
- Batch API is 50% off. This doesn't apply to interactive Claude Code runs.
- Fast mode is premium-priced (Opus 5.5: $8 / $40; Fable 5.2: $16 / $80).
- `inference_geo: "us"` multiplies everything by 1.1x on Claude 4.6+.
- Claude 4.6+ (except Haiku 5.5) bill the full 1M context at standard rates. Haiku 5.5 switches to higher prices above 100k prompt tokens.
- Claude 4.7+ use a newer tokenizer that produces about 30% more tokens for the same text, so token history from older models doesn't carry over.

### OpenAI (API, Standard tier)

Source: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Format is input / cached input / output, for prompts up to 272K tokens.

| Model | Input | Cached input | Output |
|---|---|---|---|
| gpt-6.2-astra | $8.00 | $0.40 | $40.00 |
| gpt-6.2-sol | $2.00 | $0.10 | $10.00 |
| gpt-6-astra | $10.00 | $1.00 | $50.00 |
| gpt-6.1-sol | $2.00 | $0.10 | $10.00 |
| gpt-6.1-terra | $1.00 | $0.05 | $5.00 |
| gpt-6-sol | $2.00 | $0.20 | $10.00 |
| gpt-6-luna | $0.10 | $0.01 | $0.50 |
| gpt-5.6-sol | $4.00 | $0.40 | $20.00 |
| gpt-5.6-terra | $2.00 | $0.20 | $12.00 |
| gpt-5.6-luna | $0.20 | $0.02 | $1.20 |
| gpt-5.5 | $5.00 | $0.50 | $30.00 |
| gpt-5.4 | $2.50 | $0.25 | $15.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 |
| gpt-5.3-codex | $1.75 | $0.175 | $14.00 |

Modifiers (same source):

- Above 272K input tokens, long-context rates apply, roughly 2x input and 1.5x output. Examples: gpt-6.2-astra $16 / $0.80 / $60; gpt-6.2-sol $4 / $0.20 / $15.
- Batch and Flex are 50% off; Flex is being wound down.
- "Fast" (formerly Priority) costs about 2x or more.
- Regional endpoints add a 10% uplift for models released on or after 2026-03-05.

Codex usage on an API key is billed at these API rates, not against ChatGPT quota ([Codex pricing](https://learn.chatgpt.com/docs/pricing)).

### Subscriptions (for "free until near limit")

- **Claude** ([claude.com/pricing](https://claude.com/pricing)):
  - Pro: $20/mo, 1x
  - Max: $100/mo, 5x Pro
  - Ultra: $200/mo, 10x Pro weekly, no 5-hour limit for verified accounts
  - All three include Claude Code. Limits run on a rolling 5-hour window and a weekly window.
- **ChatGPT / Codex** ([Codex pricing](https://learn.chatgpt.com/docs/pricing)):
  - Plus: $20/mo. Allowance is stated as *local messages per 5 hours* per model, for example GPT-6.2 Sol 17–180 and GPT-6.2 Astra 6–50. These are estimates, not fixed limits, and weekly limits may also apply.
  - Pro ($100/$200/$500): currently no 5-hour limit.
  - Credits buy usage past the limits.

## 2. What usage data the CLIs expose

### Claude Code

**Headless JSON** (`claude -p --output-format json` or `stream-json`). The final `result` message carries:

- `total_cost_usd`
- `usage`: main loop only
- `modelUsage`: per model, including subagents. Each entry has `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`, `costUSD`, `thinkingTokens?`, `costBasis` (`list` / `managed` / `unknown`), `canonicalModel`, `provider`.
- `duration_ms` and `duration_api_ms`

Sources: [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), [Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) (`SDKResultMessage`, `ModelUsage`).

Caveats (same sources):

- **Estimate only.** `total_cost_usd` is "client-side estimates, not authoritative billing data", computed from a price table bundled at build time.
- **Use `modelUsage`, not `usage`.** `usage` excludes subagents.
- **Per-step `output_tokens` is a placeholder.** Read output tokens from the `result` message.
- **Resumed sessions report cumulative totals.** With `--resume` / `--continue`, `total_cost_usd` includes earlier runs' spend. Take the delta yourself.
- **Error results still carry cost.** `error_max_budget_usd` and other error results include cost. A crash (`error_during_execution`) may zero it.
- **Each error subtype tells you something.** `error_max_turns`, `error_max_budget_usd` and the others can feed Routing decisions.

**Budget cap.** `--max-budget-usd` (CLI) / `maxBudgetUsd` (SDK) stops the run when the estimate reaches the cap. It can overshoot, so leave headroom ([TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript), [headless](https://code.claude.com/docs/en/headless)).

**OpenTelemetry.** Claude Code can export per-session token and cost metrics ([Manage costs](https://code.claude.com/docs/en/costs)). This is overkill for a single-user local app, but an option.

### Codex CLI

**`codex exec --json`** emits JSONL events: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`. `turn.completed` carries `usage` with these fields, as defined in source ([non-interactive mode docs](https://learn.chatgpt.com/docs/non-interactive-mode); `codex-rs/exec/src/exec_events.rs`, `struct Usage`, openai/codex at `ebd0765`):

- `input_tokens`
- `cached_input_tokens`
- `cache_write_input_tokens`
- `output_tokens`
- `reasoning_output_tokens`

There is **no dollar figure** and no rate-limit data in `exec --json`.

**`codex app-server`** is a JSON-RPC server over stdio JSONL ([app-server docs](https://learn.chatgpt.com/docs/app-server)). It gives richer data:

- `thread/tokenUsage/updated` notifications with `tokenUsage.total` and `tokenUsage.last` (`totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`) and `modelContextWindow`. Schema: `codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsage.ts`, `TokenUsageBreakdown.ts`.
- Quota methods, covered in section 3.

## 3. Can subscription quota remaining be read programmatically?

### ChatGPT / Codex: yes, officially, via `codex app-server`

`account/rateLimits/read` is documented as "fetch ChatGPT rate limits" ([app-server docs](https://learn.chatgpt.com/docs/app-server)). Its response is defined in `codex-rs/app-server-protocol/schema/typescript/v2/GetAccountRateLimitsResponse.ts`, `RateLimitSnapshot.ts` and `RateLimitWindow.ts`:

```ts
GetAccountRateLimitsResponse = {
  ordinaryUsageAllowed: boolean | null,
  rateLimits: RateLimitSnapshot,
  rateLimitsByLimitId: { [limitId]: RateLimitSnapshot } | null,
  ...
}
RateLimitSnapshot = {
  limitId, limitName,
  primary: RateLimitWindow | null,    // 5-hour window
  secondary: RateLimitWindow | null,  // weekly window
  credits: { hasCredits, unlimited, balance } | null,
  planType, rateLimitReachedType, ...
}
RateLimitWindow = {
  usedPercent: number,
  windowDurationMins: number | null,
  resetsAt: number | null,
}
```

What else is available:

- **Live updates.** `account/rateLimits/updated` is a sparse notification "emitted whenever a user's ChatGPT rate limits change". Merge it into the last snapshot.
- **Activity summary.** `account/usage/read` returns a token-activity summary with optional daily buckets. It requires ChatGPT-backed auth; an API key alone is not accepted.
- **Persisted snapshots.** In `codex-rs/protocol/src/protocol.rs`, `TokenCountEvent { info, rate_limits }` carries the same snapshot alongside token usage inside sessions.
- **Interactive and web views.** `/status` in the TUI and chatgpt.com/codex/settings/usage show the same data to a human ([Codex pricing](https://learn.chatgpt.com/docs/pricing)).

**Caveats:**

- `ordinaryUsageAllowed: null` means "unavailable", not "fine".
- Plus allowances are given as message ranges, so the Orchestrator should treat `usedPercent` as the truth and not try to convert it to dollars.

### Claude Max / Pro: only inside a session, no standalone read

There are two documented surfaces, and both need a Claude Code session that has made at least one API call.

**1. Status line JSON** ([statusline docs](https://code.claude.com/docs/en/statusline)) has these fields:

- `rate_limits.five_hour.used_percentage`
- `rate_limits.seven_day.used_percentage` (0–100)
- `rate_limits.*.resets_at` (Unix epoch seconds)

The docs say `rate_limits` "appears only for claude.ai Pro, Max, and Ultra subscribers" and "only after the first API response in the session". Each window may be absent. The status line only runs in interactive sessions, so for headless runs this is mostly a reference for the field shape.

**2. `rate_limit_event`** in the SDK / stream-json message stream ([TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript), `SDKRateLimitEvent`):

```ts
{ type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected",
    resetsAt?: number,
    utilization?: number,
    errorCode?: "credits_required",
    overageEnabled?: boolean,
    ...
  } }
```

This is the practical signal for a headless Orchestrator. Watch each Claude run's stream:

- `allowed_warning` means "near limit"; stop treating Claude as free.
- `rejected` means the quota is exhausted until `resetsAt`.

**What is *not* available:**

- `/usage` is interactive. It fetches plan limits from a usage endpoint, but that endpoint is not documented for third-party use ([Manage costs](https://code.claude.com/docs/en/costs)). The docs mention it is itself rate limited.
- I found no documented public API that returns a Claude subscriber's remaining 5-hour or weekly quota without starting a session. Calling Claude Code's internal OAuth endpoint directly would be undocumented and brittle. *Not verified; avoid unless a later ticket decides otherwise.*

## 4. Recommended approach for the Orchestrator

1. **Price table.** Keep a local, editable `prices` table keyed by model ID, with a `retrieved_at` date, sourced from the two pricing pages above. Include cache-read, cache-write and long-context rules.
2. **Cost after a run (actual estimate).**
   - Claude: store `total_cost_usd` and `modelUsage` from the `result` message. Take the delta when resuming.
   - Codex: sum `turn.completed.usage` (or `thread/tokenUsage/updated` totals) and price it with the table. Charge cached input at the cached rate, and treat reasoning tokens as part of output (OpenAI bills reasoning as output).
3. **Spend vs notional cost.** Record a `billing_mode` per run: `api` or `subscription`. For subscription runs, record the computed figure as *API-equivalent cost* (savings), not spend.
4. **Cost before a run (prediction).**
   - Start with a prior per (Agent, Model Tier) from historical runs, for example the median and p90 of tokens per run, bucketed by ticket size or labels.
   - Price that prior with the table.
   - Optionally add the opening prompt's exact size via the free `POST /v1/messages/count_tokens` (Claude; "an estimate", rate-limited per tier; [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)) or `POST /v1/responses/input_tokens` (OpenAI; [counting tokens](https://developers.openai.com/api/docs/guides/token-counting)).
   - Both counting endpoints need API keys, which a subscription-only setup may not have. The historical prior works without them.
5. **Guardrail.** Pass `--max-budget-usd` on API-billed Claude runs. Codex has no equivalent flag in the docs reviewed; enforce by killing the process when summed usage crosses the cap.
6. **Quota "free until near limit".**
   - Codex: poll `account/rateLimits/read` before routing (and subscribe to `account/rateLimits/updated`). Treat it as free while `max(primary, secondary).usedPercent` is below a threshold (for example 80%).
   - Claude: there is no pre-flight read. Keep the last `rate_limit_event` / `resetsAt` seen per account. Treat it as free unless the last status was `allowed_warning` or `rejected` and `resetsAt` hasn't passed.
   - Optionally run a tiny Haiku probe to refresh the reading. That spends a little quota.

## Open questions for other tickets

- Does `claude -p --output-format stream-json` emit `rate_limit_event` on every response or only on threshold changes? The SDK reference says "when the session encounters a rate limit". Verify empirically on a Max account (ties to #2).
- What exactly does `utilization` mean (0–1 vs 0–100), and which window does it refer to? Not stated in the reference.
- Codex quota windows differ by plan (Pro: no 5-hour window), so `primary` may be null. Routing rules (#7) must handle that.

## Sources

All retrieved 2026-11-25.

- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic token counting: https://platform.claude.com/docs/en/build-with-claude/token-counting
- Claude plans: https://claude.com/pricing
- Claude Code headless: https://code.claude.com/docs/en/headless
- Claude Code costs: https://code.claude.com/docs/en/costs
- Claude Code status line: https://code.claude.com/docs/en/statusline
- Agent SDK cost tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Agent SDK TypeScript reference: https://code.claude.com/docs/en/agent-sdk/typescript
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- OpenAI token counting: https://developers.openai.com/api/docs/guides/token-counting
- Codex pricing and plan limits: https://learn.chatgpt.com/docs/pricing
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex app-server: https://learn.chatgpt.com/docs/app-server
- openai/codex source at commit `ebd0765` (2026-11-25):
  - `codex-rs/exec/src/exec_events.rs`
  - `codex-rs/protocol/src/protocol.rs`
  - `codex-rs/app-server-protocol/schema/typescript/v2/{GetAccountRateLimitsResponse,RateLimitSnapshot,RateLimitWindow,AccountRateLimitsUpdatedNotification,ThreadTokenUsage,TokenUsageBreakdown,CreditsSnapshot}.ts`
