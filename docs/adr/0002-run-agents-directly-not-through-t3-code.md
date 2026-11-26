# Run Agents directly, not through T3 Code

The Orchestrator starts Claude Code and Codex itself, as one-shot headless runs (`claude -p`, `codex exec`) in worktrees it manages. It does not drive a running T3 Code through T3 Code's MCP server, even though the project's name suggests that it would. T3 Code's MCP tools can choose a Model Tier, take an output schema and launch into a worktree. But they return no usage, cost or quota information, which Routing, Escalation and Cost all depend on. They also leave permission approvals to a human in the T3 Code app, which would stall unattended runs. And they would make a second app, with an MCP surface that has no stability promise, a hard requirement.

## Consequences

- Agent runs sit behind one narrow interface: start a run at a Model Tier in a worktree, stream its events, get a final result plus usage. v1 ships only the direct implementation; a T3 Code-backed one stays possible but is out of scope.
- Runs are one-shot: there is no steering mid-run, so the long-lived Agent SDK session and `codex app-server` connection are not needed for runs (`codex app-server` may still be used to read ChatGPT quota).
- The Orchestrator builds what T3 Code would have given it: worktree create/reset, permission settings for unattended runs, and usage parsing. It borrows T3 Code's ideas (adapter shape, `usage_limit` classification, usage readers) but none of its runtime.
- T3 Code stays an optional tool the user may use by hand, for example to open a worktree when taking over a Ticket.
