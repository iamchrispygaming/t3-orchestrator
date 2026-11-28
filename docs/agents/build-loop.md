# Build loop

Builds [Spec: T3 Orchestrator v1](https://github.com/iamchrispygaming/t3-orchestrator/issues/20) ticket by ticket until nothing is left, without the user naming tickets. You are the **lead**: you choose work, hand it to **workers**, merge, and repeat. Skill paths are in `where-things-live.md`.

## Vocabulary

- **Build ticket**: an open issue labelled `ready-for-agent` whose body links the Spec. The Spec itself (#20) also carries `ready-for-agent` but is never a build ticket: drop it from every query. (`wayfinder:*` issues are planning records, never build tickets.)
- **Frontier**: build tickets that are unassigned and have no open blocker. Query:
  ```
  gh issue list --label ready-for-agent --state open --search "no:assignee" --json number,title
  gh api repos/{owner}/{repo}/issues/<n> --jq .issue_dependencies_summary.blocked_by   # 0 = unblocked
  ```
  Order: lowest issue number first.
- **Claim**: `gh issue edit <n> --add-assignee @me`, done before any work so parallel workers skip it.
- **Door**: the merge-danger call from the `engineering/pr` skill. **Two-way** = cheap to walk back; **one-way** = destructive or hard to reverse (migrations of real data, public API removal, anything you can't simply revert).

## Steps

### 1. Make sure build tickets exist

If no open or closed issue links the Spec as a build ticket, follow `engineering/to-tickets` on the Spec: thin end-to-end slices, the first being a hand-made Ticket run on a fake Agent through to a merged PR, tested through the server's in-process API. Label each `ready-for-agent`, wire native blocking edges. Done when every Spec user story is covered by some ticket. Then continue without waiting for the user.

### 2. Fill the slots

Run the frontier query. Claim up to **3** frontier tickets (fewer if fewer exist) and give each to a worker (a subagent, or a separate session if this tool has no subagents; if neither exists, work them yourself one at a time). Each worker gets its own git worktree and branch `build/<n>-<slug>` from the latest `main`, and this brief:

> Implement GitHub issue #<n> following `engineering/implement` and `engineering/tdd` (paths in `docs/agents/where-things-live.md`; read `AGENTS.md`, `GLOSSARY.md` and `docs/adr/` first). Open a PR whose body follows `engineering/pr`, including the door call, with `Closes #<n>`. Then review your own branch with `engineering/code-review` and fix every finding. Report back: PR URL, door (one-way / two-way), test command and result.

Done when every claimed ticket has a worker running.

### 3. Land each finished PR

When a worker reports:

- **Tests red or the review still has findings**: send it back to the same worker with the failures. After two failed rounds, unassign the ticket, comment what went wrong, add `needs-info`, and leave it for the user.
- **Green, clean, two-way**: merge with `gh pr merge <pr> --squash --delete-branch` once CI (if any) is green. The issue closes through `Closes #<n>`.
- **Green, clean, one-way**: leave the PR open, comment "One-way door: waiting for the user to merge", and move on. Its dependents stay blocked until the user merges it.

Then go back to step 2. A merge can unblock new frontier tickets.

### 4. Stop

Stop when the frontier is empty **and** no worker is running. Report to the user, by ticket title with links:
- merged this session;
- one-way PRs waiting for them;
- tickets marked `needs-info` and why;
- tickets still blocked, and on what.

## Rules that hold throughout

- Follow the Spec and the decided behaviour in its map; when a ticket conflicts with them, comment on the ticket and mark it `needs-info` rather than guessing.
- Run only the fake Agent in tests. Real `claude` / `codex` runs use the user's subscription quota and happen only in the manual smoke test, which the user runs.
- Keep `main` green: merge only branches rebased on the latest `main` with passing tests.
- Commit and PR attribution, glossary edits and ADRs follow the skills named above.
