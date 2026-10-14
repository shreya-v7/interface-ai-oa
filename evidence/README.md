# Evidence

Start with [metrics.md](metrics.md), generated from saved evidence by `npm run metrics`.
The saved [live-discovered capability](../capabilities/open_savings_subaccount_to_review/v2.json)
is the immutable artifact used by the current replay evaluation.

| Folder / file | Produced by | Contents |
| --- | --- | --- |
| `discovery/<run-id>/` | `npm run discover` | Bedrock discovery journal, summary, and model-free shadow replays on different inputs for both tenants. |
| `verification/<capability>-v<N>/` | `npm run verify` | Re-verification after code changes: model-free shadow replays on both banks. |
| `eval/` | `npm run eval` | `report.md` summarizes results; `report.json` retains every case and verdict. `events.jsonl` retains all events with run IDs. `provenance.json` records code and artifact digests. `diagnostics/<case>/` keeps masked screenshots and text-free structures for the first varied case per scenario and tenant, plus both handoffs. |
| `fixture-eval/` | `npm run eval -- --fixture` | The same evaluation on the handwritten fixture, kept separate from live results. |
| `demos/<scenario>-<bank>/` | `npm run demo:replay`, `demo:failure`, `demo:handoff` | One folder per demonstrated outcome. |
| `mcp-invoke/` | `npm run demo:mcp` | A real stdio MCP client listing and calling the capability on bank B. |
| `sso-handoff/` | Compiled browser integration run | Local OIDC sign-in as tenant B's operator, live takeover and resume of the saved capability, independent simulator record checks, and logout. A scripted operator performs the intervention. |
| `metrics.json`, `metrics.md` | `npm run metrics` | Tokens, cost, latency, grounding, acceptance, reproducibility, outcome and output accuracy. |
| `validation.json` | Final build and test run | Test totals, runtime fingerprint, replay gates, and authentication/recovery coverage. |

All data is synthetic. Each run is scanned for planted sensitive values before its
journal is consolidated. Duplicate per-case files are then removed. Metrics support
both the combined journal and older `runs/<case>/events.jsonl` layouts; missing run
evidence causes an error. Handoffs use a scripted test operator. The model spending
ledger remains in untracked `.runs/model-budget.json` so cleanup preserves the budget.
