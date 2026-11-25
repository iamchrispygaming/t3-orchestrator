# How T3 Code drives agents, and what the Orchestrator can reuse

Ticket: #3. Researched 2026-11-25 against `pingdotgg/t3code` at commit
[`ca81b7b`](https://github.com/pingdotgg/t3code/tree/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd)
(main, 2026-11-24). All paths below are relative to that commit; `T3/` abbreviates
`https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/`.

## Short answer

- T3 Code is a **Node WebSocket server that wraps provider CLIs** and serves web, Electron
  desktop, and React Native mobile clients ([`AGENTS.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/AGENTS.md), [`README.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/README.md)). It does not resell tokens; it drives the CLIs the user is already logged in to.
- **Claude Code** is driven through `@anthropic-ai/claude-agent-sdk`'s `query()`, which spawns the
  `claude` binary with a streaming prompt queue. **Codex** is driven through `codex app-server`, a
  long-lived JSON-RPC process over stdio, with an Effect client generated from OpenAI's protocol
  schema. Other agents go through ACP (Agent Client Protocol) or dedicated adapters.
- All providers sit behind one **`ProviderAdapterV2`** interface with declared **capabilities**;
  orchestration never branches on provider names.
- State is **event-sourced into SQLite** (commands -> events + projections + outbox in one
  transaction; side effects run after commit).
- License: **MIT for source only**; names/logos ("T3", "T3 Code", "T3 Tools") are trademarked.
- The biggest reuse opportunity is probably **not code**: T3 Code already exposes an
  **MCP server** (`/mcp`) that outside agents can use to launch, message, and read threads. The
  Orchestrator could treat a running T3 Code as its execution backend instead of spawning CLIs
  itself.

## Architecture

Monorepo (pnpm + `vp`/Vite+), key pieces ([`AGENTS.md` "Where code lives"](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/AGENTS.md), [`docs/internals/01_architecture.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/docs/internals/01_architecture.md)):

| Part | Role |
| --- | --- |
| `apps/server` | Owns provider processes, terminals, Git, checkpoints, durable state. WebSocket RPC (`ws.ts`), HTTP, MCP, CLI (`t3`). Default port 3773 (`apps/server/src/config.ts`). |
| `packages/contracts` | Effect/Schema wire contracts shared by server and all clients. |
| `packages/client-runtime` | Shared connection + domain state for web/desktop/mobile. |
| `packages/provider-core` | Adapter interface (`ProviderAdapter.ts`), `ProviderHost`, model catalog, usage readers. |
| `packages/provider-*` | One package per non-built-in provider (acp, cursor, opencode, pi, grok, kiro, muse, fx). |
| `packages/effect-codex-app-server` | Typed client for `codex app-server`. |
| `packages/source-control-*`, `issue-tracker-linear` | Forge integrations (GitHub, GitLab, ...) for PRs/issues. |
| `apps/web`, `apps/desktop`, `apps/mobile` | React/Vite UI; Electron wrapper (bundles the server); Expo/React Native. |

Execution always happens in the "environment" (the server's machine); clients are remote controls
over authenticated RPC (`01_architecture.md`). Every capability is meant to be a service method so it
is reachable from WebSocket, MCP tools, scheduled tasks, and the CLI alike
([`docs/internals/02_effect-services.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/docs/internals/02_effect-services.md)).

## How it launches and talks to agents

### Claude Code: Agent SDK `query()`
`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (~15.6k lines):
- Imports `query`, `forkSession`, etc. from `@anthropic-ai/claude-agent-sdk` (dep `^0.3.321` in
  `apps/server/package.json`).
- Builds `query({ prompt, options: { ...options, spawnClaudeCodeProcess } })` where `prompt` is an
  async iterable fed from an unbounded queue, so follow-up/steer messages are pushed into one live
  process (around lines 1685-1835).
- Options include `model`, `permissionMode` (default / `bypassPermissions` etc.), `canUseTool`
  (installed in every mode to surface approvals and `AskUserQuestion`), `includePartialMessages: true`,
  `resume: <nativeThreadId>` or `sessionId` for new sessions, `resumeSessionAt`, allowed/disallowed
  tools, effort, thinking display, `pathToClaudeCodeExecutable` (lines ~2575-2680).
- MCP server credentials are sent via `setMcpServers()` after init, deliberately kept out of argv
  and env. Boot has an explicit timeout because the SDK leaves it unbounded.
- Resume reads prior messages via a worker (`getSessionMessages`) before reopening.

### Codex: `codex app-server` JSON-RPC
- `apps/server/src/provider/CodexProvider.ts` launches `${binaryPath} app-server`;
  `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` spawns it with Effect's
  `ChildProcessSpawner` and talks JSON-RPC over stdio.
- **One app-server per provider instance serves all Codex threads**, frames routed by thread
  (comment near line 1826). Hung servers are detected with request/initialize deadlines and retired.
- Methods used include `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `turn/start`,
  `turn/steer`, `turn/interrupt`, `thread/compact/start`, `config/read`; notifications like
  `turn/started`, `turn/completed`, `turn/diff/updated`, `thread/tokenUsage/updated`.
- Server-initiated requests handled for approvals and input: `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
  `item/tool/requestUserInput`, `mcpServer/elicitation/request` (lines ~6300-6745).
- `packages/effect-codex-app-server/scripts/generate.ts` generates schemas from
  `openai/codex` `codex-rs/app-server-protocol`.

### Everything else
ACP agents go through `packages/provider-acp` with strict spec compliance; dedicated adapters exist
for non-ACP protocols ([`docs/internals/03_providers.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/docs/internals/03_providers.md), [`docs/internals/adding-a-provider.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/docs/internals/adding-a-provider.md)).

Note: T3 Code does **not** run agents as one-shot `claude -p` / `codex exec` calls. It keeps
long-lived interactive sessions so it can steer, approve, interrupt, and fork mid-turn.

## Provider abstraction

`packages/provider-core/src/server/ProviderAdapter.ts`:
- `ProviderAdapterV2` service: `getCapabilities()`, `planSelectionTransition()`, `openSession()`.
- `openSession` returns a `ProviderAdapterV2SessionRuntime`: an `events` stream plus
  `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`,
  `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, `forkThread`, and optional
  `compactThread`, `injectHistory`, `applyModelSelection`, `stopSubagent`, MCP apps/sign-in.
- Session status: `starting | ready | running | waiting | stopped | error`.
- Typed tagged errors for every failure (turn start, steer declined, interrupt timeout, protocol
  error, ...).

Rules from `03_providers.md` worth copying:
- Route by **provider instance** (an account/config), not driver kind; two accounts on the same
  CLI never share state; strip ambient credentials the instance didn't configure.
- **Declare only real capabilities**; never emulate a permission mode by auto-answering approvals.
- Health/model probes stay passive (never open a session that starts MCP servers or logins).
- Classify quota/rate-limit failures as `usage_limit` with reset time.
- Every terminal path (completion, stop, error, process exit) must settle open tools/requests.
- Prove adapters with **replay fixtures recorded from the real provider**
  (e.g. `apps/server/src/orchestration-v2/testkit/fixtures/*/claude_transcript.ndjson`).

## Session and state handling

Glossary ([`docs/internals/00_glossary.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/docs/internals/00_glossary.md)): **Thread** = durable conversation (survives
process exit); **Turn/Run** = one user->agent cycle; **Session** = provider runtime attached to a
thread, stoppable/resumable; **Checkpoint** = workspace snapshot stored as a hidden Git ref.

Durability (`01_architecture.md`, `apps/server/src/orchestration-v2/`):
- `Orchestrator.ts` serializes commands and decides events with no I/O.
- `EventSink.ts` commits events, projections, command receipts (idempotent retries), and
  **outbox effects** in one SQLite transaction (`apps/server/src/persistence/Sqlite.ts`, Effect
  `SqlClient`; file `statev2.sqlite` under `~/.t3/userdata`).
- `EffectWorker.ts` runs side effects (start provider turn, capture checkpoint) after commit and
  feeds results back as commands. Effects tied to a lost provider process are retired on recovery,
  not replayed (`ProviderRuntimeRecoveryService.ts`).
- "Run completed" (provider turn ended) and "follow-up settled" (checkpoint/diff/PR sync) are
  separate milestones.
- Threads can use their own Git worktree.

## Tech stack

TypeScript everywhere; **Effect 4** (`effect` 4.1.5 in `pnpm-workspace.yaml`) for services, schemas,
RPC, SQL, child processes; Node (root engines `26.13.1`, server `^22.16 || >=24.10`) with
`node:sqlite`; pnpm 12 + Vite+ (`vp`); web: React, Vite, TanStack Router, Zustand, Tailwind 4;
desktop: Electron 44; mobile: Expo 58 / React Native 0.88; `node-pty` terminals; a small Rust
resource monitor (`native/`). Sources: the respective `package.json` files.

## License

- [`LICENSE`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/LICENSE): MIT, (c) 2026 T3 Tools Inc. Copying code is fine with the notice kept.
- [`TRADEMARK.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/TRADEMARK.md): MIT covers source only. "T3 Code", "T3 Connect", "T3 Tools", and the
  **"T3" wordmark** are protected; derivative projects must use their own branding, must not adopt
  "T3 Code" as a name, and must be prominently marked unofficial. **Flag:** a public project named
  "T3 Orchestrator" may draw attention under this policy; fine for private/personal use, but
  consider a rename before publishing.

## What the Orchestrator could reuse or learn from

### Option A: use T3 Code as the execution backend (via its MCP server)
T3 Code serves MCP at `<environment>/mcp` for "outside agents"
([`docs/user/outside-agents.md`](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/docs/user/outside-agents.md)), with OAuth sign-in and per-client permission levels.
Tools include `t3_project_list`, `t3_thread_launch`, `t3_thread_send`, `t3_thread_wait`,
`t3_thread_read`, `t3_thread_interrupt`, `t3_worktree_*`, plus PR/issue tools
(`apps/server/src/mcp/toolkits/`). `delegate_task` / `create_threads` exist but `delegate_task` is
hidden from outside clients (`toolkits/orchestrator/tools.ts`).
- Pros: provider launch, approvals, worktrees, checkpoints, model catalog, usage tracking, mobile
  approvals all come free; fits "sits above T3 Code".
- Cons: hard runtime dependency on a running T3 Code; MCP tool surface may change; less control
  over exactly how agents are invoked.

### Option B: drive CLIs directly, borrowing T3 Code's approach
- Use the **same transports**: Claude Agent SDK `query()` with streaming input + `resume`, and
  `codex app-server` JSON-RPC. Consider vendoring `packages/effect-codex-app-server` (MIT) if using
  Effect, or just its generator idea.
- Copy the **adapter contract shape**: open session / start turn / interrupt / respond to approval /
  event stream, with declared capabilities, so routing stays provider-agnostic.
- For one-shot Tickets the Orchestrator may not need steering or forking; a much smaller interface
  is likely enough.

### Ideas worth stealing either way
- **Command -> event -> outbox** in one SQLite transaction for crash-safe dispatch of Tickets.
- **Provider instance** as the routing unit (account + config), not "Claude vs Codex".
- **`usage_limit` classification** with reset time, useful for "cheapest capable" routing fallback.
- **Usage readers** (`apps/server/src/provider/Drivers/claudeUsage.ts`, `codexUsage.ts`) parse
  local CLI transcripts for token/cost estimates; good input for a cost model.
- **Model manifest** (`apps/server/src/provider/model-manifest.json`) as a data source for which
  models exist per provider.
- **Worktree per thread** and hidden-ref checkpoints for isolation.
- **Replay-fixture testing** of adapters instead of hand-written protocol frames.

### Probably not worth reusing
The full server: it is very large (Claude adapter alone ~15.6k lines, Codex ~9.7k), Effect-heavy,
and built for multi-surface, remote, multi-user-device needs the Orchestrator does not have.

## Open questions
- Which T3 Code MCP tools and permission level would the Orchestrator need, and is that surface
  stable enough to depend on?
- Does the Orchestrator want Effect at all? Reusing T3 Code code effectively implies it.
- Naming vs `TRADEMARK.md` if the project is ever published.
