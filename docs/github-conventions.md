# GitHub conventions

How the Orchestrator marks work on a Target Repo, and what it reads back. The Spec is the parent issue and its Tickets are sub-issues with native dependencies. Each Ticket works on branch `t3o/<issue#>-<slug>` and has one PR.

## Labels on a Ticket's issue

| Label | Meaning |
|---|---|
| `model:<agent>:<model>/<effort>` | The Model Tier that should work the Ticket. Examples: `model:claude:haiku/medium`, `model:codex:gpt-6.2-sol/low`. `<agent>` is `claude` or `codex`. `<effort>` is everything after the last `/`. |
| `door:one-way` / `door:two-way` | The planned door. |

The Orchestrator writes these labels only when it publishes a Plan. It never writes status labels: a Ticket's state lives in the Orchestrator, not on GitHub.

The user can edit either label on GitHub. The next poll picks the edit up. The Orchestrator also reads the issue's labels fresh at the two moments they decide something: just before the first Run starts (its tier) and just before an auto-merge (the door). An edit made after the last poll still counts. For the tier, a read that a poll overtook (the poll observed the labels while the read was in flight, even without seeing a change) is dropped, and what the poll stored stands. For the door the rule is stricter: a Ticket auto-merges only when the fresh read and the door the last poll stored both say two-way. Both one-way sends it to the merge Checkpoint. Any disagreement means no merge now, and the decision is taken again after the next poll. Nothing merges while any current source says one-way.

- **`model:*`**: if the Ticket's first Run has not started, the Ticket is re-routed to the named Model Tier. Once the first Run has started, the edit is ignored, because Escalation owns the tier from then on. An issue with no `model:*` label, an unreadable one, or two naming different tiers keeps its current tier.
- **`door:*`**: before merge, the label replaces the planned door, so it can tighten or loosen it. Door resolution still takes the most cautious of the planned door, the Agent's call and the reviewer's call. That means an Agent or reviewer can still bump a loosened Ticket back to one-way. An issue with both door labels reads as one-way. An issue with neither keeps its current door.

## Polling

Every 30 seconds the Orchestrator sends each Target Repo one change probe: a REST conditional request carrying the last ETag. An unchanged repo answers `304` and costs nothing more. Only a repo that changed gets the one structured read (GraphQL). That read returns each issue's state, labels, parent, sub-issues and blocked-by issues, and each PR's state and the issues it closes. Every issue is named by repository plus number, since Target Repos share issue numbers and these links can cross repositories. A PR merged on GitHub marks its Ticket Merged within one poll. A PR is matched to its Ticket by its recorded number. Until a number is recorded, it is matched by branch (`t3o/<issue#>-<slug>`) and its number is then recorded, so a merge made while the Orchestrator is still creating the PR is caught too. Once the number is known, another PR from the same branch never counts. The first poll after a start reads every repo.
