# Where things live

Everything the build needs that sits outside this repo's `main` branch, or outside the repo entirely.

## Skills

The engineering skills used to plan this project are Matt Pocock's skills, installed as a Claude Code plugin. Read them as plain files: each skill is a folder with a `SKILL.md` and sometimes sibling files it links to (read those too when the `SKILL.md` points at them).

Base folder: `C:\Users\LanDome\.claude\plugins\cache\claude-plugins-official\mattpocock-skills\<version>\skills\`. The version folder is `1.3.1` today; a plugin update adds a newer one, so take the highest version present.

| Reach for it when | Skill (path under the base folder) |
|---|---|
| Splitting the spec into build tickets | `engineering/to-tickets` |
| Building a ticket | `engineering/implement`, test-first with `engineering/tdd` |
| Designing a module's interface or seam | `engineering/codebase-design` |
| Something is broken, throwing or slow | `engineering/diagnosing-bugs` |
| Writing a PR body (door call + blast radius) | `engineering/pr` |
| Reviewing a branch or PR | `engineering/code-review` |
| Resolving a term or recording an ADR | `engineering/domain-modeling` |
| A question needs the user's decision | `productivity/grilling` |
| A "how should it look/behave" question | `engineering/prototype` |
| A fact from outside docs or APIs | `engineering/research` |
| Editing `AGENTS.md`, a skill or an agent doc | `productivity/writing-for-agents` |

The spec decides that the Orchestrator ships its **own credited copies** of `engineering/pr` and `engineering/code-review` inside this repo, so Agents never depend on the plugin. Copy them from here when that slice is built.

## Planning record (GitHub Issues)

- [Spec: T3 Orchestrator v1](https://github.com/iamchrispygaming/t3-orchestrator/issues/20): what to build, labelled `ready-for-agent`. Start here.
- [Map: T3 Orchestrator v1](https://github.com/iamchrispygaming/t3-orchestrator/issues/1): every decision behind the spec; each closed child issue holds one decision with its reasoning. Read the relevant one before changing a decided behaviour.

## Branches that are never merged

Read with `git show origin/<branch>:<path>`; never merge or check them out onto `main`.

| Branch | File | What it holds |
|---|---|---|
| `research/headless-agents` | `research/headless-agents.md` | Running `claude -p` / `codex exec` unattended: flags, streamed JSON, result schemas, permission modes |
| `research/cost-and-quota` | `research/cost-and-quota.md` | Reading usage, Cost and subscription quota from both CLIs |
| `research/github-tracking` | `research/github-tracking.md` | Polling GitHub: conditional requests, the GraphQL query, sub-issues and dependencies |
| `research/t3-code` | `research/t3-code.md` | What T3 Code does and which MIT files are worth copying |
| `prototype/dashboard` | `prototype/dashboard/index.html` | Dashboard shell and Ticket cards (chosen: `?variant=B`) |
| `prototype/dashboard-pages` | `prototype/dashboard/pages.html` | Home, Agents, Planner, Activity pages; chosen variants are in the spec. Home D is the "operations floor" kept for the later visual design pass |

Prototypes encode **structure** only; their styling is a placeholder.
