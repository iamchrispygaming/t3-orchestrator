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
Everything the Planner produces for one idea: a Spec, its Tickets, the blocking edges between them, and each Ticket's Model Tier with a one-line reason. The user approves a Plan as a whole at the plan-approval Checkpoint; until then it exists only in the Orchestrator.

**Spec**
The written description of what one Plan builds. Once the Plan is approved, it becomes the parent issue on the Target Repo, with the Plan's Tickets as its sub-issues.
_Avoid_: PRD, design doc

**Ticket**
One unit of build work on the Target Repo, recorded as a GitHub issue: sized so one unattended Agent run produces one pull request, and self-contained, with acceptance criteria the Agent can check. The Planner names the Model Tier that should work it, with a one-line reason; the user can change it when approving the plan.

**Routing**
Choosing the Model Tier that first works a Ticket. The Planner names it for each Ticket from the Ladder, picking the cheapest it judges capable. When that Agent is near its quota limit, the Orchestrator moves the Ticket to the next more capable Model Tier of another Agent, and pauses if every Agent is near its limit.

**Escalation**
Retrying a Ticket from scratch on the next more capable Model Tier on the Ladder after a cheaper one fails it. When the most capable Model Tier fails, the Ticket stops and is handed to the user.

**Checkpoint**
A point where the Orchestrator stops for the user: approving the plan, and merging a Ticket's pull request. Everything between Checkpoints runs unattended.
