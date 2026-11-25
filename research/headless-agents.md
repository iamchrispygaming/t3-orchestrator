# How do Claude Code and Codex run unattended?

Research for issue #2. Researched 2026-11-25 against Claude Code **2.1.330** and Codex CLI **0.171.0** (the versions installed locally). Both CLIs change quickly; re-check `--help` when upgrading.

Sources are marked like **[CC-headless]**, listed at the bottom. **[local]** means a check run on this machine: `--help` output or a real one-line run.

## TL;DR

| Concern | Claude Code | Codex |
|---|---|---|
| Headless entry point | `claude -p "<prompt>"` (`--print`) | `codex exec "<prompt>"` |
| Final structured result | `--output-format json`: one JSON object | `-o <file>` (last message) + `--json` stream |
| Streamed events | `--output-format stream-json --verbose` (NDJSON) | `--json` (JSONL on stdout) |
| Schema-constrained answer | `--json-schema '<schema>'`, read from `structured_output` | `--output-schema schema.json` |
| Unattended permissions | `--permission-mode auto\|acceptEdits\|dontAsk\|bypassPermissions` + `--allowedTools` + `--permission-prompts none` | `--sandbox workspace-write` (+ `-c approval_policy="never"`), or `--approve-for-me` |
| Working directory | process cwd (or `-w/--worktree`) | `-C <dir>` (or `--worktree`) |
| Model Tier | `--model <alias\|full id>` + `--effort low..max` | `-m <model>` + `-c model_reasoning_effort=<level>` |
| Usage at the end | `usage` (tokens), `modelUsage` per model, **`total_cost_usd`**, `num_turns`, `duration_ms` | `turn.completed.usage` (tokens only, **no cost**) |
| Session id for retry/resume | `session_id` → `--resume <id>` | `thread.started.thread_id` → `codex exec resume <id>` |
| Auth for scripts | `ANTHROPIC_API_KEY` (required under `--bare`) or the stored login | `CODEX_API_KEY` or the saved CLI login |

## 1. Invocation

### Claude Code

`claude -p "<prompt>"` runs non-interactively and exits. It exits `0` on success and non-zero on failure. A failure inside the run, such as missing auth, is printed as the result on stdout **[CC-headless]**. A piped stdin is read as extra input, capped at 10 MB **[CC-headless]**.

Flags that matter for the Orchestrator (all present in `claude --help` **[local]**):

- `--bare`: skips auto-discovery of hooks, skills, plugins, MCP servers, auto memory and CLAUDE.md. The docs call it "the recommended mode for scripted and SDK calls", and say it will become the default for `-p`. Under `--bare`, auth is **only** `ANTHROPIC_API_KEY` or an `apiKeyHelper`; OAuth/keychain is never read **[CC-headless]**. If the Orchestrator should use the user's subscription login, it must **not** pass `--bare`. Without `--bare`, `-p` loads the project's `.claude/settings.json` hooks and `.mcp.json`, with no trust dialog **[CC-headless]**.
- `--append-system-prompt` / `--system-prompt`: inject Orchestrator instructions such as "commit on this branch, don't push".
- `--max-budget-usd <amount>`: a hard spend cap per run (`-p` only) **[local]**.
- `--session-id <uuid>`: pre-assign the session id so the Orchestrator knows it before the run starts **[local]**.
- `--no-session-persistence`: don't save the transcript (but then the run can't be resumed) **[local]**.
- `--fallback-model a,b`: per-turn fallback when the primary model is overloaded **[CC-model]**. This is *not* the Orchestrator's tier escalation, which should be a separate run.
- Signals: SIGTERM exits with 143 and leaves the turn unfinished. Send SIGINT first to end the turn cleanly **[CC-headless]**.
- Background work: after its turn, `-p` may wait up to 10 min for background subagents or commands Claude started (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). `--bare` disables background tasks **[CC-headless]**.

### Codex

`codex exec "<prompt>"` runs non-interactively. Progress goes to stderr and only the final agent message goes to stdout **[CX-exec]**. If you pass no prompt (or `-`), stdin is the prompt. If you pass a prompt and pipe stdin, stdin is appended as context **[CX-exec]**. Locally, `codex exec` printed `Reading additional input from stdin...` when stdin was an open pipe **[local]**. The Orchestrator should spawn it with **stdin closed or `/dev/null`** so it doesn't hang.

Relevant flags (`codex exec --help` **[local]**):

- `-C, --cd <DIR>`: working root.
- `--skip-git-repo-check`: Codex refuses to run outside a git repo by default **[CX-exec]**. A Ticket worktree is a git repo, so the Orchestrator won't need this flag.
- `--ephemeral`: don't persist the session rollout (but then the run can't be resumed).
- `--ignore-user-config`, `--ignore-rules`, `-p/--profile <name>` (layers `$CODEX_HOME/<name>.config.toml`), `-c key=value` (any config override).
- Project config and project MCP servers load only for **trusted** projects. `--trust` persists trust **[CX-exec]**. A required MCP server that fails to start makes `exec` exit with an error **[CX-exec]**.

## 2. Structured and streamed output

### Claude Code

- `--output-format json` prints one object at the end. Fields include `result` (final text), `session_id`, `is_error`, `subtype`, `num_turns`, `duration_ms`, `usage`, `modelUsage`, `total_cost_usd` and `permission_denials` **[CC-headless]**. A real run **[local]** returned `"type":"result","subtype":"success","is_error":false,"num_turns":1,"stop_reason":"end_turn","terminal_reason":"completed"`, plus many timing and diagnostic fields. The parser should ignore fields it doesn't know.
- `--output-format stream-json --verbose` prints NDJSON events: `system/init` first (model, tools, MCP servers, plugins), then `assistant`/`user` messages, `system/api_retry`, `permission_denied`, and finally a `result` message. Find the result by `type`, because "a message such as a task notification can follow a result and start another turn" **[CC-headless]**. Add `--include-partial-messages` for token deltas. Subagent messages carry `parent_tool_use_id` **[CC-headless]**.
- `--json-schema '<schema>'` with `--output-format json` puts the validated object in `structured_output`. If the run ends without valid output, the field is **absent**, so check for it **[CC-headless]**. This is how the Orchestrator can get a machine-readable Ticket verdict, for example `{status, summary, commits[]}`.

### Codex

- `--json`: stdout becomes JSONL. The event types are `thread.started` (with `thread_id`), `turn.started`, `turn.completed` (with `usage`), `turn.failed`, `item.started`/`item.updated`/`item.completed`, and `error` **[CX-exec]**. Item types: `agent_message`, reasoning, command executions, file changes, MCP tool calls, web searches and plan updates **[CX-exec]**.
- Observed run **[local]**:
  ```jsonl
  {"type":"thread.started","thread_id":"01a21179-…"}
  {"type":"turn.started"}
  {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
  {"type":"turn.completed","usage":{"input_tokens":18027,"cached_input_tokens":13824,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
  ```
- `-o/--output-last-message <file>` writes the final message to a file (it also still goes to stdout) **[CX-exec]**.
- `--output-schema ./schema.json` constrains the final response to a JSON Schema. Combine it with `-o` to get the JSON in a file **[CX-exec]**.

## 3. Permissions and auto-approve

### Claude Code

`--permission-mode` choices **[local]**: `manual`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. From v2.1.302, `-p` starts in **Manual** when nothing sets a mode. In a Manual `-p` run, any call that needs approval is **denied** unless an allow rule, a hook or `--permission-prompt-tool` approves it **[CC-headless]**.

- `acceptEdits`: file writes plus common fs commands (`mkdir`, `mv`, `cp`). Other shell commands still need `--allowedTools` **[CC-headless]**.
- `auto`: a classifier reviews each action **[CC-headless]**.
- `dontAsk`: denies everything that would prompt. Allow rules and read-only actions still run **[CC-headless]**.
- `bypassPermissions` / `--dangerously-skip-permissions`: no checks. The help text recommends it "only for sandboxes with no internet access" **[local]**.
- `--allowedTools "Bash(git *) Edit Read"`: tool allow-list in permission-rule syntax. Note the space before `*` **[CC-headless]**.
- `--permission-prompts none` (v2.1.259+): nothing waits on a human, and anything still unresolved is denied. Denials appear in `permission_denials` in the result **[CC-headless]**.

**Suggested Orchestrator default:** `--permission-mode acceptEdits --allowedTools "<test/build/git commands>" --permission-prompts none`. Escalate to `auto` if Tickets need arbitrary shell. Record `permission_denials`: a non-empty list is a signal that the run failed for permission reasons, not capability.

### Codex

- The sandbox defaults to **read-only** in `exec` **[CX-exec]**. `--sandbox workspace-write` allows edits in the working root (and `--add-dir` dirs). `danger-full-access` is for externally sandboxed environments only **[CX-exec]**.
- Network inside `workspace-write` is controlled by `sandbox_workspace_write.network_access` (bool) **[CX-config]**.
- `approval_policy`: `on-request` or `never` (or a `granular` table). The docs advise `never` for non-interactive runs. `untrusted` is unsupported and `on-failure` is deprecated **[CX-config]**.
- `--full-auto` is no longer supported. Use `--sandbox workspace-write`, or `--approve-for-me`, which "route[s] approval requests through automatic review using the workspace-write sandbox" **[CX-exec]** **[local]**.
- `--dangerously-bypass-approvals-and-sandbox`: no sandbox and no prompts **[local]**.

**Suggested Orchestrator default:** `codex exec --sandbox workspace-write -c approval_policy="never" -C <worktree>`, with `-c sandbox_workspace_write.network_access=true` only if a Ticket needs to install packages.

## 4. Running in a git worktree

Both CLIs have a built-in worktree flag: `claude -w/--worktree [name]` **[local]** **[CC-workflows]** and `codex exec --worktree` ("Run the session in a new managed Git worktree") **[local]**. But the two tools create their worktrees in different places and clean them up differently. For the Orchestrator, the simpler and tool-neutral approach is:

1. The Orchestrator runs `git worktree add <path> -b ticket/<n>-<slug> <base>` itself.
2. It runs Claude with the process **cwd** set to `<path>`, and Codex with `-C <path>` (plus cwd).
3. It inspects the branch afterwards (`git log base..HEAD`, `git diff`) to decide pass/fail, then pushes and opens a PR, or removes the worktree.

This makes tier escalation easy. A retry at a higher tier can reuse the same worktree (continuing the work) or reset it to `<base>` (a clean attempt). Codex needs the directory to be a git repo, which a worktree is **[CX-exec]**. Claude's `--worktree` needs at least one commit in the repo **[CC-workflows]**. Codex may need the worktree path marked trusted (`projects.<path>.trust_level` or `--trust`) to load project config **[CX-exec]** **[CX-config]**.

## 5. Selecting a Model Tier per run

### Claude Code

- `--model <alias|full name>`. Aliases: `haiku`, `sonnet`, `opus` (`best` is the same as `opus`), `fable`, `sonnet[1m]`, `opus[1m]`, `opusplan`. Aliases resolve to the latest version per provider. Use a full id such as `claude-opus-5-5` to pin **[CC-model]**. `--model` and `ANTHROPIC_MODEL` apply only to that session **[CC-model]**.
- `--effort low|medium|high|xhigh|max`. Support varies by model. The default is `medium` for the 5.5-generation models. `CLAUDE_CODE_EFFORT_LEVEL` takes precedence over `--effort` **[CC-model]**. **Don't set that env var globally**, or it overrides the per-run tier.

### Codex

- `-m, --model <MODEL>` **[local]**, or `-c model="<id>"`.
- `-c model_reasoning_effort=<level>`. The levels are whatever the model advertises, such as `low`, `medium`, `high`, `xhigh`, `max`, `ultra` **[CX-config]**.
- Profiles (`-p <name>` → `$CODEX_HOME/<name>.config.toml`) can bundle model + effort into named tiers **[local]** **[CX-config]**.

**Implication for the domain model:** a Model Tier is a pair of (model, effort) per Agent, for example `claude:{haiku,low} < claude:{sonnet,medium} < claude:{opus,high}` and `codex:{<small>,low} < codex:{<flagship>,medium} < codex:{<flagship>,high}`. Store tiers as data, because model ids churn.

## 6. Usage and token reporting at the end

### Claude Code

From the JSON result (observed **[local]**, documented **[CC-headless]**):

- `total_cost_usd`: a client-side **estimate**. It can differ from the bill. When you use `--resume`/`--continue`, it is the **whole conversation's** total, earlier runs included **[CC-headless]**.
- `usage`: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `server_tool_use.{web_search_requests,web_fetch_requests}`, `service_tier`, and an `iterations[]` per-request breakdown **[local]**.
- `modelUsage`: a map from model id to `{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens, thinkingTokens, …}` **[local]**. Note the camelCase here versus snake_case in `usage`. This map shows which model actually ran, for example after a `--fallback-model` switch.
- Also `num_turns`, `duration_ms`, `duration_api_ms`, `session_id`, `is_error`, `subtype` (`success` or an error subtype), `permission_denials` **[local]**.

### Codex

- `turn.completed.usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` **[local]** (the docs list all but `cache_write_input_tokens` **[CX-exec]**).
- **No cost figure and no model name** are reported. The Orchestrator must record the model it passed and compute cost from its own price table. One `exec` is one turn, so take the `usage` from the last `turn.completed`. A failed run emits `turn.failed`/`error` instead **[CX-exec]**. Their payloads are not documented, so treat them as opaque and log them.

## 7. Resuming and retrying

- Claude: capture `session_id` (or pre-set it with `--session-id`), then `claude -p "<follow-up>" --resume <id>` **[CC-headless]**.
- Codex: capture `thread_id` from `thread.started`, then `codex exec resume <id> "<follow-up>"` (or `--last`). A resumed run reuses the cwd and sandbox unless you put overrides **before** `resume` **[CX-exec]**.
- For "retry one tier up", a **fresh** run at the new tier in the same worktree is simplest. Resuming across models is possible in Claude (`--resume` + `--model`), but cost reporting then accumulates across runs **[CC-headless]**.

## 8. Reference invocations

```bash
# Claude Code: work a Ticket in an Orchestrator-made worktree
cd "$WT" && claude -p "$TICKET_PROMPT" \
  --model sonnet --effort medium \
  --output-format stream-json --verbose \
  --permission-mode acceptEdits --allowedTools "Bash(npm *) Bash(git *)" \
  --permission-prompts none \
  --max-budget-usd 2 \
  --json-schema "$VERDICT_SCHEMA" \
  --session-id "$UUID" \
  --append-system-prompt "Commit your work on the current branch. Do not push."

# Codex: same Ticket
codex exec "$TICKET_PROMPT" -C "$WT" \
  -m "$CODEX_MODEL" -c model_reasoning_effort="medium" \
  --sandbox workspace-write -c approval_policy="never" \
  --json --output-schema verdict.schema.json -o "$WT/.verdict.json" \
  < /dev/null
```

## Open questions and gaps

- The payloads of Codex `turn.failed`/`error` events and Codex exit codes are not documented on the page read. Verify them empirically before relying on them.
- Whether Codex `--approve-for-me` uses extra model calls, and whether those count in the reported `usage`.
- Codex `--worktree` placement and cleanup were not researched, because the recommendation is to own worktrees.
- Claude subscription (OAuth) vs API-key billing: `total_cost_usd` is reported either way, but under a subscription it is notional.

## Sources

- **[CC-headless]** Claude Code docs, "Run Claude Code programmatically": https://code.claude.com/docs/en/headless
- **[CC-model]** Claude Code docs, "Model configuration": https://code.claude.com/docs/en/model-config
- **[CC-workflows]** Claude Code docs, "Common workflows → Run parallel sessions with worktrees": https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees
- **[CX-exec]** Codex docs, "Non-interactive mode": https://developers.openai.com/codex/noninteractive (redirects to https://learn.chatgpt.com/docs/non-interactive-mode); linked from `docs/exec.md` in https://github.com/openai/codex
- **[CX-config]** Codex docs, "Config reference": https://developers.openai.com/codex/config-reference (redirects to https://learn.chatgpt.com/docs/config-file/config-reference); linked from `docs/config.md` in https://github.com/openai/codex
- **[local]** `claude --help` (2.1.330), `codex exec --help` (0.171.0), and one-line runs: `claude -p "Reply with the word ok" --model haiku --output-format json --permission-mode dontAsk` and `codex exec --json --ephemeral --skip-git-repo-check --sandbox read-only "Reply with the word ok"`.
