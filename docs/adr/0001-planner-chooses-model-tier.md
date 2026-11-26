# The Planner chooses each Ticket's Model Tier

Routing was first sketched as a Planner difficulty rating fed through a fixed table of rules. We dropped the rating and the table: the Planner names the Model Tier for each Ticket directly from the Ladder, using its own judgement of what each Agent and model is good at, and picks the cheapest it judges capable. The user reviews and can change every choice at the plan-approval Checkpoint. A fixed table could not tell that one Ticket suits Codex and another suits Claude, and the user wanted that judgement made per Ticket rather than by a number.

## Consequences

- Everything after the choice stays mechanical so it costs no extra Planner usage: moving off an Agent near its quota limit goes to the next more capable Model Tier of another Agent, and Escalation climbs the Ladder without asking the Planner again.
- The Ladder is still ordered by capability. The Planner uses it as a menu; Escalation uses it as a ladder.
- Routing quality now depends on the Planner's knowledge of models, which the user corrects at the Checkpoint rather than by editing rules.
