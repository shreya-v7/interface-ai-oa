# Metrics

Computed by `npm run metrics` from saved evidence. Grounding measures rejected unknown element references; acceptance measures decisions accepted by the runtime. Output accuracy requires agreement between returned values, the rendered review, and simulator records.

## Discovery (model in the loop)

### Run 973eeec0-41af-4cab-8366-dd9643f7bf66

| Measure | Value |
| --- | --- |
| Model calls / decisions | 22 / 22 |
| Tokens in / out | 54601 / 1142 (per call in: p50 2519, max 2776) |
| Cost | $0.0212 |
| Model call latency | p50 1197 ms · p95 1429 ms · max 1463 ms |
| Wall time | 26.9 s |
| Grounding rate | 100.0% |
| Acceptance rate | 72.7% |
| Executed actions / verified checkpoints / finish | 8 / 7 / 1 |
| Rejected decisions | 6 {"CHECKPOINT_REQUIRED":4,"CHECKPOINT_ALREADY_VERIFIED":1,"SYMBOLIC_INPUT_REQUIRED":1} |

### Run c07670ef-dd7e-43e4-9626-19fd0eafa8fe

| Measure | Value |
| --- | --- |
| Model calls / decisions | 22 / 22 |
| Tokens in / out | 54601 / 1142 (per call in: p50 2519, max 2776) |
| Cost | $0.0212 |
| Model call latency | p50 743 ms · p95 1167 ms · max 1315 ms |
| Wall time | 18.7 s |
| Grounding rate | 100.0% |
| Acceptance rate | 72.7% |
| Executed actions / verified checkpoints / finish | 8 / 7 / 1 |
| Rejected decisions | 6 {"CHECKPOINT_REQUIRED":4,"CHECKPOINT_ALREADY_VERIFIED":1,"SYMBOLIC_INPUT_REQUIRED":1} |

Reproducibility: 2 saved artifacts, 1 distinct content digest(s) (independent runs produced identical capabilities).

## Replay (no model)

| Measure | Value |
| --- | --- |
| Cases | 132 |
| Outcome accuracy | 100.0% |
| Output factual accuracy (success cases) | 100.0% |
| False successes | 0 |
| Model calls during replay | 0 |
| Run latency (changed-input cases) | p50 628 ms · p95 2785 ms · max 2812 ms |
| Step latency (dispatch → verified checkpoint, 946 steps) | p50 52 ms · p95 114 ms · max 2244 ms |

Outcome accuracy by expected class:

- success: 62/62
- business_outcome: 20/20
- failed: 30/30
- escalated: 20/20

Hard gates: {"falseSuccess":0,"unsafeDispatches":0,"forbiddenEffects":0,"modelCalls":0,"ownershipViolations":0,"leaks":0}

## Training

None. No model is trained or fine-tuned; there are no training metrics. Discovery uses an off-the-shelf model; replay uses no model.
