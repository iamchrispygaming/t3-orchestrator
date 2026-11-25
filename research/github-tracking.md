# How should a local app follow GitHub issue and PR activity?

Research for issue #5. Sources are GitHub's official docs, read 2026-11-25. Each claim links to the page it came from.

## Recommendation (TL;DR)

1. **Poll, don't rely on webhooks.** A single-user app on a Windows machine has no public URL. GitHub's tunnelling options (`gh webhook forward`, smee.io) are documented as test-only. Webhooks are never retried automatically, and missed deliveries can only be redelivered for 3 days. Even with a tunnel, the app would still need a polling reconcile loop to catch events missed while it was off. So polling is the source of truth.
2. **Use one GraphQL query per Target Repo per poll cycle** to read the whole Ticket/PR graph: open issues with labels, `subIssues`/`parent`, `blockedBy`/`blocking`, and linked PRs (`closedByPullRequestsReferences` on issues, `closingIssuesReferences` on PRs). REST would need N+1 calls for the same data.
3. **Add a cheap REST change detector in front of it**, using conditional requests: `GET /repos/{o}/{r}/issues?state=all&sort=updated&since=…` with `If-None-Match`. A `304` costs nothing against the primary rate limit, so the GraphQL query only runs when something changed.
4. **Use REST for writes** (create issue, add labels, add sub-issue, add dependency). Send them serially, at most about one per second, to stay under the content-creation secondary limits.
5. **Optional later:** while the app is running, `gh webhook forward` could push events for lower latency. Treat it only as a hint that triggers an immediate poll, never as the source of truth.

## 1. Polling vs webhooks vs tunnels

| Option | Works for local app? | Key facts |
|---|---|---|
| Webhooks to a public endpoint | No public endpoint | The server must reply with 2XX within 10 s ([handling deliveries][deliv]). "GitHub does not automatically redeliver failed deliveries" ([failed deliveries][failed]). Manual or API redelivery reaches back only 3 days ([redelivering][redeliver]). |
| `gh webhook forward` (gh extension `cli/gh-webhook`) | Yes, while running | "only designed for use during testing and development", "not supported for use in production". It covers repo and org webhooks only. "Only one person can use webhook forwarding at a time for each repository" (otherwise `Hook already exists`). Org hooks need the `admin:org_hook` scope ([gh webhook forward][ghfwd]). |
| smee.io proxy | Yes, while running | GitHub's own guide uses smee for local testing but says "You should not use smee.io to forward your webhooks in production" ([handling deliveries][deliv]). It is also a third-party relay that sees payloads. |
| Polling REST/GraphQL | Yes | GitHub's guidance prefers webhooks, but where you must poll: poll on a schedule, honour `x-poll-interval`, and use conditional requests ([best practices][bp]). |
| Events API (`GET /repos/{o}/{r}/events`) | Technically yes | "not built to serve real-time use cases". Latency runs from 30 s to 6 h, it returns at most 300 events covering 30 days, and it supports ETag/`X-Poll-Interval` ([events][events]). That latency is too slow to drive Ticket state, so it is not recommended. |

**Conclusion:** a local-first app that may be offline for hours needs a reconcile-by-polling design anyway, so webhooks can at most reduce latency.

## 2. Rate limits

### REST ([REST rate limits][restrl], [best practices][bp])
- Primary limit: 5,000 req/h for an authenticated user (PAT, or OAuth/GitHub App acting for the user), shared across all of them. Unauthenticated: 60/h per IP.
- Secondary limits:
  - At most 100 concurrent requests, shared with GraphQL.
  - 900 points/min for REST (GET = 1, POST/PATCH/PUT/DELETE = 5).
  - Content creation: 80 req/min and 500 req/h. Some endpoints have lower limits, and actions in the web UI count too.
  - CPU time: 90 s per 60 s of real time (no more than 60 s of it for GraphQL).
- Headers: `x-ratelimit-limit/remaining/used/reset/resource`. On a secondary limit, honour `retry-after`. Otherwise wait for `x-ratelimit-reset`, or at least 1 minute with exponential backoff. There is no API to query secondary-limit status.
- **Conditional requests:** store `etag` and send `If-None-Match`, or store `last-modified` and send `If-Modified-Since`. "Making a conditional request does not count against your primary rate limit if a `304` response is returned". This applies only to authorized requests. Keep params, page size and sort stable, because each different query yields a different ETag ([best practices][bp]).
- Make requests serially. For bulk mutations, "wait at least one second between each request" ([best practices][bp]).

### GraphQL ([GraphQL limits][gqlrl])
- Primary limit: 5,000 **points**/h per user. Cost is the number of connection requests, assuming max `first`/`last`, divided by 100 with a minimum of 1. The actual cost is readable via `rateLimit { cost remaining }`.
- Each connection's `first`/`last` must be 1–100, with at most 500,000 nodes per call.
- Secondary limit: 2,000 points/min (query = 1, mutation = 5). A request that runs over 10 s is killed with a 502/504 and costs extra primary points.
- GraphQL has no ETag/304 support, so pairing it with a REST conditional "did anything change?" probe is what saves budget.

**Budget sanity check:** polling 5 Target Repos every 30 s with a conditional REST probe is about 600 req/h. Most of those return 304 and are free. Even a worst case with every probe a 200 and a roughly 2–5 point GraphQL query each time stays well under 5,000/h.

## 3. APIs needed by the Orchestrator

### Labels (`model:*` assignment) ([labels][labels])
- Create a repo label: `POST /repos/{o}/{r}/labels`. Create `model:*` labels up front; the docs don't say whether adding a missing label auto-creates it.
- Add labels to an issue: `POST /repos/{o}/{r}/issues/{n}/labels`, which merges with existing labels. Replace them all: `PUT …/labels`. Remove one: `DELETE …/labels/{name}`. List: `GET …/labels`.
- Filter when listing: `GET /repos/{o}/{r}/issues?labels=model:foo&state=all&since=ISO8601`. `since` means "Only show results that were last updated after the given time". This endpoint **also returns PRs**, which you can tell apart by the `pull_request` key ([issues][issues]).
- Webhook/timeline signal: `issues` `labeled`/`unlabeled` ([payloads][payloads]), and the timeline Labeled/Unlabeled events ([timeline][timeline]).

### Sub-issues ([sub-issues REST][subrest], [adding sub-issues][subdoc])
- `GET …/issues/{n}/parent`, `GET …/issues/{n}/sub_issues`, `POST …/issues/{n}/sub_issues` with body `sub_issue_id` and optional `replace_parent`, `DELETE …/issues/{n}/sub_issue` (singular), and `PATCH …/sub_issues/priority` with `after_id`/`before_id`.
- **`sub_issue_id` is the issue's database `id`, not its `number`.** Fetch the issue first to get `id`.
- Limits: 100 sub-issues per parent and 8 nesting levels. Sub-issues can come from other repositories.
- GraphQL: `Issue.subIssues`, `Issue.parent`, `Issue.subIssuesSummary`; mutation `addSubIssue(issueId, subIssueId | subIssueUrl, replaceParent)` ([GraphQL issues][gqlissues]).
- Webhook: `sub_issues` with `parent_issue_added|removed` and `sub_issue_added|removed` ([payloads][payloads]).

### Issue dependencies (blocked by / blocking) ([dependencies REST][deprest], [creating dependencies][depdoc])
- `GET …/issues/{n}/dependencies/blocked_by`, `POST …/dependencies/blocked_by` with body `issue_id`, `DELETE …/dependencies/blocked_by/{issue_id}`, and `GET …/issues/{n}/dependencies/blocking`. Again, **`issue_id` is the database id**.
- POST/DELETE can trigger secondary rate limits. The docs state no limit on the number of dependencies.
- GraphQL: `Issue.blockedBy`, `Issue.blocking`, `Issue.issueDependenciesSummary`; mutation `addBlockedBy(issueId, blockingIssueId)` ([GraphQL issues][gqlissues]).
- Webhook: `issue_dependencies` with `blocked_by_added|removed` and `blocking_added|removed` ([payloads][payloads]).

### Linking PRs to issues ([linking a PR][link])
- Closing keywords in the PR body (or in commits): `close(s|d)`, `fix(es|ed)`, `resolve(s|d)`. Use `Closes #10` in the same repo, or `Fixes owner/repo#100` across repos.
- **Keywords only link and auto-close if the PR targets the default branch.** Otherwise they are ignored.
- A keyword in a commit message closes the issue on merge, but the PR is *not* shown as linked. Put the keyword in the PR **body**.
- At most 10 issues per PR and 10 PRs per issue. Manual linking happens through the "Development" sidebar.
- Reading links (GraphQL): `PullRequest.closingIssuesReferences` (args `userLinkedOnly`, `excludeUserLinked`) ([GraphQL pulls][gqlpulls]), and `Issue.closedByPullRequestsReferences`, described as "List of open pull requests referenced from this issue" ([GraphQL issues][gqlissues]). REST has no direct field for this. The closest is the issue timeline (`GET …/issues/{n}/timeline`), with Connected/Disconnected and Cross-referenced events ([timeline][timeline]).
- PR state via webhook: `pull_request` actions include `opened`, `closed`, `reopened`, `synchronize`, `ready_for_review`, `converted_to_draft`, `labeled`, `review_requested`, and `enqueued`. `pull_request_review` has `submitted`, `edited` and `dismissed`. `check_suite`/`check_run` cover CI ([payloads][payloads]).

## 4. Suggested polling design

1. For each Target Repo, every N seconds (honour `x-poll-interval` if present):
   `GET /repos/{o}/{r}/issues?state=all&sort=updated&direction=desc&per_page=100&since=<lastSync>` with `If-None-Match: <etag>`.
   - `304`: nothing changed, at no primary-limit cost.
   - `200`: collect the changed issue/PR numbers, then run one GraphQL query for those nodes. Fetch labels, state, `subIssues`, `parent`, `blockedBy`, `closedByPullRequestsReferences`, and for PRs `closingIssuesReferences`, `isDraft`, `merged`, `reviewDecision`, and the status rollup.
2. Persist `etag`, `lastSync`, and the snapshot locally, and diff it to derive Ticket state transitions.
3. Run a full reconcile on startup, since webhooks would have been missed while offline anyway.
4. Route all mutations through a serial queue with 1 s spacing and `retry-after`/backoff handling.

Caveat: `since` filters on `updated_at`. Check by experiment whether adding a sub-issue or dependency, or linking a PR, bumps the parent issue's `updated_at`. If it doesn't, those relationship changes need either the periodic full GraphQL reconcile or the PR's own update to surface them. (Not verified in the docs.)

## Sources

[restrl]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[gqlrl]: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
[bp]: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
[ghfwd]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing
[deliv]: https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries
[failed]: https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
[redeliver]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
[events]: https://docs.github.com/en/rest/activity/events
[payloads]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[labels]: https://docs.github.com/en/rest/issues/labels
[issues]: https://docs.github.com/en/rest/issues/issues
[timeline]: https://docs.github.com/en/rest/issues/timeline
[subrest]: https://docs.github.com/en/rest/issues/sub-issues
[subdoc]: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
[deprest]: https://docs.github.com/en/rest/issues/issue-dependencies
[depdoc]: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies
[link]: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
[gqlissues]: https://docs.github.com/en/graphql/reference/issues
[gqlpulls]: https://docs.github.com/en/graphql/reference/pulls

- REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GraphQL rate/query limits: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- REST best practices: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- gh webhook forward: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing
- Handling webhook deliveries: https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries
- Handling failed deliveries: https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
- Redelivering webhooks: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
- Events API: https://docs.github.com/en/rest/activity/events
- Webhook events and payloads: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- Labels: https://docs.github.com/en/rest/issues/labels
- Issues: https://docs.github.com/en/rest/issues/issues
- Timeline: https://docs.github.com/en/rest/issues/timeline
- Sub-issues REST: https://docs.github.com/en/rest/issues/sub-issues
- Adding sub-issues: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- Issue dependencies REST: https://docs.github.com/en/rest/issues/issue-dependencies
- Creating issue dependencies: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies
- Linking a PR to an issue: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
- GraphQL Issues reference: https://docs.github.com/en/graphql/reference/issues
- GraphQL Pull requests reference: https://docs.github.com/en/graphql/reference/pulls
