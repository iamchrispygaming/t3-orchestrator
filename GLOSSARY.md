# Glossary

**Orchestrator**
The single-user, local-first dashboard that plans work with the user and assigns it to models. It sits above agent tools such as T3 Code in the workflow: it hands out the work, while those tools stay optional for the user to use by hand. It is not a fork of them and does not depend on them.

**Target Repo**
Any GitHub repository the user points the Orchestrator at. Work is planned and tracked as issues on the Target Repo. The Orchestrator's own repository is just one possible Target Repo.

**Cost**
How much of the user's subscription usage a piece of work consumes. It is measured as what the run would cost at API list prices, so that different Agents and models can be compared on one scale. Usage is never free: Routing aims for the cheapest Model Tier capable of the work.
_Avoid_: "free" quota; raw tokens (they don't compare across models)

**Agent**
A coding tool the Orchestrator runs unattended to work a Ticket, such as Claude Code or Codex. An Agent can run at several Model Tiers.
_Avoid_: AI, bot

**Model Tier**
One way of running an Agent: a model plus how hard it thinks (its effort).

**Ladder**
The user-editable list of available Model Tiers across all Agents, ordered from least to most capable. The Planner picks from it; Escalation climbs it.

**Planner**
The single strong model that plans an idea with the user, writes the spec and splits it into Tickets. Which model serves as the Planner is never chosen to save Cost.

**Plan**
Everything the Planner produces for one idea: a Spec, its Tickets, the blocking edges between them, each Ticket's Model Tier with a one-line reason, and whether each Ticket is expected to be a One-way or Two-way Ticket. The user approves a Plan as a whole at the plan-approval Checkpoint; until then it exists only in the Orchestrator.

**Spec**
The written description of what one Plan builds. Once the Plan is approved, it becomes the parent issue on the Target Repo, with the Plan's Tickets as its sub-issues.
_Avoid_: PRD, design doc

**Ticket**
One unit of build work on the Target Repo, recorded as a GitHub issue: sized so one unattended Agent run produces one pull request, and self-contained, with acceptance criteria the Agent can check. The Planner names the Model Tier that should work it, with a one-line reason, and whether it is a One-way or Two-way Ticket; the user can change either when approving the plan.

**One-way Ticket**
A Ticket whose change is hard to walk back once merged, such as a destructive migration, a public API removal or another hard-to-reverse decision. Its pull request always stops at the merge Checkpoint. When the Planner's expectation and the Agent's own call on the finished work disagree, or the call is missing or unclear, the Ticket is One-way.
_Avoid_: risky Ticket

**Two-way Ticket**
A Ticket whose change is cheap to walk back. Once its Agent reports it done, its checks pass and its Review approves, its pull request merges without the user, unless the Target Repo has no checks, needs a human approval to merge, or has auto-merge turned off.

**Routing**
Choosing the Model Tier that first works a Ticket. The Planner names it for each Ticket from the Ladder, picking the cheapest it judges capable. When that Agent is near its quota limit, the Orchestrator moves the Ticket to the next more capable Model Tier of another Agent, and pauses if every Agent is near its limit.

**Escalation**
Starting a new Run of a Ticket, from scratch, on the next more capable Model Tier on the Ladder after a Run on a cheaper one fails. When the most capable Model Tier fails, the Ticket stops in a Handback.

**Checkpoint**
A point where the Orchestrator stops for the user: approving the plan, and merging a One-way Ticket's pull request (a Two-way Ticket's pull request usually merges without one). Everything between Checkpoints runs unattended.

**Run**
One unattended Agent run on one Ticket at one Model Tier. A Ticket has one or more Runs: Escalation, Refresh, and redoing a Run cut short when the Orchestrator itself stopped each start a new one from a freshly reset worktree (the last at the same Model Tier, not counted as a failure), while a Run asked for at the merge Checkpoint continues the existing work with the user's feedback.
_Avoid_: attempt, job

**Review**
One unattended read of a Ticket's pull request by the other Agent, at a Model Tier above the one that wrote it, ending in approve or changes needed. A Two-way Ticket cannot merge without an approving Review; for a One-way Ticket the Review only advises the user at the merge Checkpoint. A Review never commits and is not a Run: it uses up no Model Tier.
_Avoid_: code review (the user's own review at the merge Checkpoint)

**Refresh**
A new Run of a Ticket at the same Model Tier, started because the default branch moved under its open pull request and a plain rebase conflicts. It is not an Escalation: the Ticket did not fail, so no Model Tier is used up.

**Handback**
An unplanned stop where the Orchestrator gives one Ticket back to the user because it cannot finish it unattended: the most capable Model Tier failed it or judged it unclear or impossible, its pull request was closed without merging, Refreshes kept conflicting, its checks never finished, a Run the user asked for at the merge Checkpoint failed, or the user stopped its Run. The user retries it at a Model Tier of their choice, re-plans it through the Planner, or takes it over. Unlike a Checkpoint, it is never part of the plan.
_Avoid_: Checkpoint (those are the two planned stops)
