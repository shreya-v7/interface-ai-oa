# Architecture

The problem is reliable execution inside legacy software with no usable API.
The prototype prepares a synthetic savings application through its review screen.
It searches for a member, opens the correct record, fills the application, and
returns four values read from the review. It never opens a real account.

The flow is: **observe UI, choose an action, enforce policy, execute, verify,
compile, replay**. During discovery, Bedrock receives the current UI tree, goal,
input symbols, and recent action results. It proposes one typed decision at a time.
The compiler saves executed actions and verified checkpoints. Replay imports no
model client. One local worker owns one browser session.
The worker exclusively owns a local state directory; browsers use separate contexts.

| Stack                    | Why it is used                                                |
| ------------------------ | ------------------------------------------------------------- |
| TypeScript and Node.js   | Shared types across the contract, runtime, and tests          |
| Playwright and Chromium  | Frame navigation, browser control, and request blocking       |
| Zod                      | Validate inputs, model decisions, artifacts, and tool schemas |
| AWS Bedrock, Nova 2 Lite | Real discovery with measured token usage and cost             |
| Fastify                  | Small local simulator and operator server                     |
| MCP SDK                  | Standard capability catalog and typed agent calls             |
| jose                     | Signed OpenID Connect token verification                      |
| Vitest                   | Repeatable contract, browser, safety, and handoff tests       |
| JSON and JSONL           | Reviewable artifacts and evidence without a database          |

# Artifact schema

Each immutable capability contains app compatibility, typed inputs and outputs,
frame-scoped targets, input bindings, steps, preconditions, postconditions,
repeatability rules, completion checks, and provenance. A SHA-256 digest detects
changes. Verification separately binds the artifact, runtime, policy, and tenant
profiles to successful replay evidence.

The model supplies values through input symbols. The compiler replaces known
record-specific values and routes with bindings, and rejects remaining discovery
literals. Money uses integer minor units. Outputs come from the visible review,
not from echoing the request. Automated verification is not human approval.

# Determinism & error handling

Locator anchors must identify the same element. The results row must match the
requested member. Actions pin the scanned DOM node and recheck its live metadata,
so replacement controls cannot inherit an old authorization. Ambiguous or conflicting targets stop execution. Each action
has a bounded wait that checks both its checkpoint and known error screens.

Not-found and validation results are business outcomes. Reviewed handlers recover
from a notice or transient read error within a retry limit. Wrong review values
and permission errors fail. Unknown states escalate. An uncertain write is never
blindly repeated.

Replay syncs action intents and checkpoints through atomic file replacement.
Restart marks unfinished runs interrupted and blocks new work until operator review.
MCP request keys are scoped to the service identity and tenant. They prevent duplicate
dispatch across restarts; keyed fingerprints
detect changed arguments without saving their values. Lost sessions never restart
automatically. Storage errors stop execution. Tests kill a worker after the simulator
accepts a write and verify that retrying the request causes no second write.

The evaluator independently compares returned values, rendered review rows, and
simulator records. Its 132 cases comprise 120 varied-input cases, ten identical-input
repetitions, and two scripted handoffs. Hard gates require zero false success,
forbidden effects, unsafe dispatches, replay model calls, and configured sentinel
leaks. Stale ownership is tested in handoff cases. Reports state each metric's
coverage; these synthetic results do not establish production reliability.
Separate adversarial tests inject DOM changes, output races, redirects, malformed
artifacts, and ownership races. Completion rechecks displayed values and blockers.

# Heterogeneity & multi-tenant

The same capability runs on two vendor variants. Tenant settings map origins,
frame names, and labels; bank B also changes table order and uses nearby table
text to caption fields. Profiles cannot change steps, identity, or completion.
Unsupported app versions are rejected. Browser-specific work stays in the surface
adapter. Desktop and pixel-based control are not implemented.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps each seam here to its production form:
worker leases with fencing tokens, a Postgres intent journal, digest-addressed
releases, and per-tenant isolation.

# Escalation & handoff

A stuck run pauses and revokes automation ownership. The operator takes the same
live Chromium session through a local console. A changing ownership counter rejects
stale actions. Resume verifies the member and suspended step before advancing or
performing an explicitly safe retry. Wrong state stays paused. Action kinds and
ownership changes are recorded without entered values. Tests use scripted operators.
Interrupted sessions remain visible after restart. An authenticated administrator can
acknowledge them without replaying actions or asserting success.

# Safety

A reviewed policy limits actions, targets, routes, and origins. The browser network
guard stays active during human control and blocks final account creation, including
keyboard submission. Chromium response interception validates every redirect destination
and method before following it. Popups, downloads, service workers, and WebSockets are restricted.

Evidence stores allowlisted metadata, text-free structures, and masked screenshots.
Credentials stay in local configuration. Discovery reserves cost before each request,
uses a cumulative $3 limit, and does not retry provider calls automatically. Privacy
checks cover known synthetic sentinels, not arbitrary regulated data.

The loopback console supports OpenID Connect authorization code flow with PKCE,
state, nonce, and signed-token validation through jose. A local identity provider
exercises the complete browser flow. The client supports public clients, RS256,
and same-origin discovery endpoints. HTTP is allowed only for explicitly configured
loopback providers. Invalid SSO configuration cannot enable key login.

Verified subjects map to local tenant and role grants. Lists, live events, controls,
and MCP status calls enforce those grants. Callers cannot supply their own role.
Viewer, operator, administrator, and agent permissions are tested, including foreign
run IDs and account switching. HttpOnly sessions expire after 15 minutes; logout
revokes their event streams. Key-based local administration remains an explicit mode.
Credential and state files are owner-only; durable records omit raw arguments,
outputs, and browser credentials. Stdio MCP trusts the launching OS user and selects
its service identity at startup. Permission changes require a worker restart.

# Cuts

The two stretch features are MCP invocation and cross-tenant reuse. Final account
creation, desktop control, remote co-browsing, approval UI, code generation, model
repair, distributed workers, and model training are excluded. Replay already uses
no model, so training a smaller model would not improve this execution path.

Authentication and recovery are tested against local SSO and the simulator. A real
deployment still needs validation against its identity provider and vendor app, TLS,
managed secrets, shared transactional storage, and application effect reconciliation.
These additions do not restore browser sessions or guarantee exactly-once effects.
Current results are in [metrics](evidence/metrics.md) and the
[evaluation report](evidence/eval/report.md).
