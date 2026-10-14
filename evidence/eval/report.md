# Capability evaluation

PASS - 132/132 cases matched the independent oracle.

Artifact digest: `175abb44ab4b4d67c98105b355fe13e3e7fa71fca995b1583c43fb77f14b2dba`

120 changed-input cases, 10 fixed-input repeats, 2 scripted handoffs. Browser-launch retries: 0.

| Metric | Observed | Measured in |
| --- | ---: | ---: |
| Valid task success | 50/50 (100.0%) | - |
| Replay p50 | 544 ms | - |
| Replay p95 | 2676 ms | - |
| falseSuccess - required zero | 0 | 132 cases |
| unsafeDispatches - required zero | 0 | 132 cases |
| forbiddenEffects - required zero | 0 | 132 cases |
| modelCalls - required zero | 0 | 132 cases |
| ownershipViolations - required zero | 0 | 2 cases |
| leaks - required zero | 0 | 132 cases |

Synthetic test results; the judge uses application records, not a model. Unsafe dispatches count policy-approved actions blocked by the network guard. Ownership checks cover deliberate stale actions in the handoff cases.

## Outcome confusion counts

| Expected | Reported | Count |
| --- | --- | ---: |
| success | success | 50 |
| business_outcome | business_outcome | 20 |
| failed | failed | 30 |
| escalated | escalated | 20 |

## Fixed-input repeatability

| Tenant | Runs | Action hashes | Outcome variants | Stable |
| --- | ---: | ---: | ---: | --- |
| a | 5 | 1 | 1 | true |
| b | 5 | 1 | 1 | true |

Full case verdicts: [report.json](report.json). Run events: [events.jsonl](events.jsonl).
