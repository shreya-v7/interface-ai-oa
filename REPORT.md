# Architecture

The problem is reliable execution inside legacy software with no usable API. The
prototype prepares a synthetic savings application through its review screen: it
searches for a member, opens the correct record, fills the application, and returns
four values read from the review. It never opens an account.

The flow is **discover once, compile, verify, replay many times**. During discovery,
Bedrock (Nova 2 Lite) receives the goal, the input names with their synthetic values,
the inputs not yet entered, a history of executed actions, and a normalized UI tree
with visible page text. It returns one schema-checked decision per turn. Because
values and page text reach the provider, discovery must run on sandbox or synthetic
data. The compiler keeps only executed actions and verified checkpoints. Replay
imports no model client. One local worker owns one browser session per run.

| Stack                    | Why it is used                                                |
| ------------------------ | ------------------------------------------------------------- |
| TypeScript and Node.js   | Shared types across the contract, runtime, and tests          |
| Playwright and Chromium  | Frame navigation, browser control, and request blocking       |
| Zod                      | Validate inputs, model decisions, artifacts, and tool schemas |
| AWS Bedrock, Nova 2 Lite | Real discovery with measured token usage and cost             |
| Fastify                  | Small local simulator and operator server                     |
| MCP SDK                  | Standard capability catalog and typed agent calls             |
| Vitest                   | Repeatable contract, browser, safety, and handoff tests       |
| JSON and JSONL           | Reviewable artifacts and evidence without a database          |

Local OpenID Connect sign-in and a durable run store exceed the brief. They exist to
make the handoff and retry story credible, are not part of the capability contract,
and can be ignored when assessing the core.

# Artifact schema

Each immutable capability declares app compatibility, typed inputs (patterns,
enums, ranges, sensitivity) and outputs (type, source target, parser), frame-scoped
targets, ordered steps with preconditions, postconditions, effect class (`read` or
`draft`) and repeat rule, a completion predicate, an identity binding, and
provenance. A SHA-256 digest detects edits. Verification separately binds the
artifact, runtime code, policy, and tenant profiles to replay evidence; any change
makes it uncallable until `verify` passes again.

The model supplies values only through input symbols. The compiler replaces known
record values and routes with bindings and rejects remaining discovery literals.
Money uses integer minor units. Outputs are read from the review screen and checked
against the request; on this task they are verification read-backs, because the
review exposes no application-generated identifier. Outcome codes come from a
vendor-level exception pack shared by every capability of that app, bound through
the verification digest rather than copied into each artifact. Automated
verification is not human approval.

# Determinism & error handling

Each control is described by several anchors (role and name, label, nearby caption,
and, for result rows, the row keyed by the member input). They must resolve to the
same element; ambiguity or disagreement stops the run instead of picking a match.
These anchors often derive from the same caption, so agreement guards against
selecting a different control more than it proves independence. Actions pin the
resolved DOM node and recheck its live metadata before acting. Every wait is bounded
and polls for either the step's checkpoint or a known error screen.

The taxonomy follows one rule. A **business outcome** is the application evaluating
a well-formed request and saying no (member not found, validation rejected). A
**recoverable** condition is a known transient with a reviewed, read-safe handler
(a notice to dismiss, one retry of a failed read), bounded per run. **Escalation**
means a person in the live session can fix it (expired session, ambiguous control,
unknown dialog, unverified checkpoint). **Failure** means continuing is unsafe or
the artifact is wrong (permission denied, review values not matching the request).
Failures report the step, code, and evidence; the expected and observed texts are
currently generic, which is a known gap.

Inputs are validated against the capability's schema before the simulator, browser,
or earlier evidence is touched. A failure's effect is `unknown` only when a
dispatched `draft` step was never verified; read-only failures report `none`.
Uncertain writes are never repeated. Action intents are synced before dispatch; a
restart marks unfinished runs interrupted. Only runs with an unverified write, or a
failure after human control, wait for operator review; business outcomes and
read-only failures settle normally.

The evaluator compares returned values, rendered review rows, and simulator records
with code independent of the engine: 12 fault scenarios on 2 banks with 5 input sets
each, plus 10 identical-input repeats and 2 scripted handoffs (132 cases). Hard gates
require zero false successes, forbidden effects, unsafe dispatches, replay model
calls, and planted-value leaks. These synthetic results do not establish production
reliability.

# Heterogeneity & multi-tenant

The recorded flow references controls by semantic anchors and vendor label keys
(`@label.memberId`), never by CSS, XPath, or coordinates. Perception and action sit
behind the browser adapter (`observe`, `resolve`, `act`, `check`, `read`). The seam
is not yet a formal interface: the engine still touches the Playwright page, and some
heuristics use HTML tags. A legacy web app is the case built here (framesets, nested
tables, fields captioned only by neighbouring cells, no IDs). A desktop adapter would
build the same UI tree from Windows UI Automation or macOS accessibility, and a
surface with no usable DOM would need a pixel and OCR adapter whose anchors are text
plus region. Neither is built.

One capability runs on both bank variants. Tenant profiles map origins, frame names,
and label wording; bank B also reorders columns and has no field labels. Profiles
cannot change steps, identity, or completion. Unsupported app versions are refused
before acting. Missing anchors are reported as `drift` in each result. A known
limitation: v2's heading targets include bank A's banner text as an anchor, so every
bank B run reports one missing anchor; the next compiler revision should keep only
vendor label keys. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps these seams to
production: per-tenant drift aggregation and suspension, worker leases, and
digest-addressed releases.

# Escalation & handoff

A replay that cannot safely continue pauses and revokes automation ownership. The
operator console shows the capability, step, and reason, and the operator takes the
same live Chromium session. Each handover increments an ownership epoch, so stale
automation actions and stale console clicks are refused. Resume re-reads the screen:
it advances only when the suspended step's postcondition holds, retries only when
explicitly safe, and stays paused on the wrong member or state. Human actions are
recorded by control name, never by typed value. During discovery, escalation happens
when the model requests help. Evidence uses scripted operators.

# Safety

A reviewed vendor policy allowlists routes, origins, action types, clickable
controls, and fillable fields. Irreversible actions are blocked rather than
confirmed: account creation is outside the capability's scope, so a person performs
it after the agent reads the verified review. The browser network guard blocks the
commit endpoint, off-allowlist origins, unsafe redirects, popups, downloads, and
WebSockets, for automation and humans alike, including keyboard submission.

Evidence keeps allowlisted metadata, text-free structures, and masked screenshots;
journals never hold input values. Discovery reserves cost before each call under a
cumulative $3 cap and never retries provider calls. The console uses OpenID Connect
with PKCE and per-tenant roles; MCP calls are scoped to a service identity. Privacy
checks cover planted synthetic values, not arbitrary regulated data.

# Cuts

The two stretch goals are the MCP capability catalog and cross-tenant reuse; repeat
runs are part of the evaluation, not a feature.

- **Desktop and pixel surfaces:** one surface done in depth beat several shallow
  ones. Next: extract a surface interface and build an accessibility-tree adapter.
- **Approval workflow for risky steps:** blocking is safer for this scope. Next: a
  `commit` effect class that escalates for a recorded human decision.
- **Remote co-browsing:** the operator uses the worker's window. Next: stream the
  session to the console and forward input under the same ownership epoch.
- **Code generation and model-assisted repair:** they do not strengthen the core.
- **Distributed workers and model training:** infrastructure the brief does not
  reward; replay already uses no model.

Authentication and recovery are tested only against local SSO and the simulator.
Results are in [metrics](evidence/metrics.md) and the
[evaluation report](evidence/eval/report.md).
