# Manual smoke test: Claude Code adapter

Automated tests never run `claude`, because real runs spend the user's Claude subscription quota. This is the one check that does. Run it by hand after changing `src/server/claude-code.ts` or upgrading Claude Code (flags were researched on 2.1.330–2.1.332; see the `research/headless-agents` branch).

It runs one real **Run** and one real **Review** on a throwaway repo, at a cheap Model Tier (`haiku`/`low` by default), and prints every `RunEvent`. Expect a few cents of notional Cost.

The server has no entry point and no real GitHub client yet, so this drives the adapter directly. Once `npm start` exists, also run one real Ticket end to end on a throwaway Target Repo routed to a cheap Claude Model Tier and check it reaches a merged PR.

## Before you start

- `claude` is on `PATH` as an executable (the native installer's `claude.exe`). An npm `claude.cmd` shim won't start, because the adapter spawns without a shell.
- You are logged in to Claude Code with your subscription (`claude` then `/status`). The adapter strips every variable that looks like a credential (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, ...), so the Run must find your login in Claude Code's own config folder, never in an environment variable.

## Steps

1. Make a throwaway repo with one commit, well away from real work:

   ```sh
   mkdir %TEMP%\t3o-smoke-repo && cd %TEMP%\t3o-smoke-repo
   git init && git commit --allow-empty -m init
   ```

2. From the Orchestrator clone, run:

   ```sh
   node scripts/smoke-claude-code.ts %TEMP%\t3o-smoke-repo
   ```

   Pass a model and effort to try another tier, e.g. `... sonnet medium`.

## What to check

In the `run` section:

- [ ] `TEXT` and `TOOL` lines stream while it works (e.g. `TOOL {"name":"Bash","detail":"git commit ..."}`).
- [ ] `RESULT` has `"kind": "run"`, `"status": "done"`, and `usage` with non-zero tokens and a `costUsd`.
- [ ] `git log` in the throwaway repo shows the SMOKE.md commit.
- [ ] `reason` says `git push` and `gh auth status` were refused by permissions (not that they ran and failed for lack of a login).
- [ ] `reason` says writing `../outside-the-worktree.txt` was refused, and the file does not exist.
- [ ] `reason` lists no token/key/secret variables (`none`), and the temp folder is inside the printed `scratch` folder.
- [ ] The run never stopped to ask you anything.

In the `review` section:

- [ ] `RESULT` has `"kind": "review"`, a `verdict` (`approve` expected), and `findings` saying the edit was refused.
- [ ] `git status` in the throwaway repo is clean: the Review changed nothing.

If any `RATE-LIMIT` line appears, note its `status`, `resetsAt` and `utilization`. The event shape comes from the Agent SDK reference and hasn't been seen in a real stream yet; report what you see on the PR or issue so the quota port can rely on it.

## Clean up

Delete `%TEMP%\t3o-smoke-repo` and the `t3o-smoke-*` scratch folders the script printed.
