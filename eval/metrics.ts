import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestOf } from '../src/compiler/compile.js';

/**
 * Observability report computed only from saved evidence: no re-runs, no estimates.
 * Every number below is derived from sanitized JSONL journals, the evaluation report,
 * and the capability files. Definitions are stated next to each field.
 */
type Event = Record<string, string | number | boolean>;
const time = (e: Event) => Date.parse(String(e.timestamp));

export function quantile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}
const summary = (values: number[]) => ({
  count: values.length,
  p50: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  max: values.length ? Math.max(...values) : 0,
});

/** Codes meaning the model referred to something not on the current screen. */
const UNGROUNDED = new Set(['STALE_OBSERVATION_REF', 'UNGROUNDED_TARGET']);

export function discoveryMetrics(events: Event[]) {
  const usage = events.filter((e) => e.type === 'model_usage');
  const requests = events.filter((e) => e.type === 'model_request');
  // Latency of each call: its request event to the reply (usage) event that follows it.
  const latencies: number[] = [];
  let pending: number | undefined;
  for (const e of events) {
    if (e.type === 'model_request') pending = time(e);
    else if (e.type === 'model_usage' && pending !== undefined) {
      latencies.push(time(e) - pending);
      pending = undefined;
    }
  }
  const invalid = events.filter((e) => e.type === 'invalid_model_decision');
  const byCode: Record<string, number> = {};
  for (const e of invalid) byCode[String(e.code)] = (byCode[String(e.code)] ?? 0) + 1;
  const executed = events.filter((e) => e.type === 'discovery_action').length;
  const checkpoints = events.filter((e) => e.type === 'discovery_checkpoint').length;
  const finished = events.some((e) => e.type === 'discovery_end' && e.state === 'success') ? 1 : 0;
  const decisions = usage.length;
  const ungrounded = invalid.filter((e) => UNGROUNDED.has(String(e.code))).length;
  const inputTokens = usage.map((e) => Number(e.inputTokens));
  const outputTokens = usage.map((e) => Number(e.outputTokens));
  return {
    modelCalls: requests.length,
    decisions,
    tokens: {
      input: inputTokens.reduce((a, b) => a + b, 0),
      output: outputTokens.reduce((a, b) => a + b, 0),
      inputPerCall: summary(inputTokens),
      outputPerCall: summary(outputTokens),
    },
    costUsd: Number(usage.reduce((a, e) => a + Number(e.costUsd), 0).toFixed(6)),
    callLatencyMs: summary(latencies),
    wallTimeMs: events.length ? time(events.at(-1)!) - time(events[0]!) : 0,
    outcomes: {
      executedActions: executed,
      verifiedCheckpoints: checkpoints,
      acceptedFinish: finished,
      rejected: invalid.length,
      rejectedByCode: byCode,
    },
    /** Share of decisions that referenced an element present in the current observation. */
    groundingRate: decisions ? Number(((decisions - ungrounded) / decisions).toFixed(4)) : 0,
    /** Share of decisions that passed schema, grounding, policy and protocol checks. */
    acceptanceRate: decisions
      ? Number(((executed + checkpoints + finished) / decisions).toFixed(4))
      : 0,
  };
}

/** Per-step latency: dispatch to checkpoint, scoped to run ID in combined journals. */
export function stepLatencies(events: Event[]): number[] {
  const out: number[] = [];
  const started = new Map<string, number>();
  for (const e of events) {
    const key = JSON.stringify([e.runId ?? '', e.stepId]);
    if (e.type === 'dispatch_intent') started.set(key, time(e));
    if (e.type === 'checkpoint' && started.has(key)) {
      out.push(time(e) - started.get(key)!);
      started.delete(key);
    }
  }
  return out;
}

const readJsonl = async (path: string): Promise<Event[]> =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);

export async function buildMetrics(root = '.') {
  const discoveryDir = join(root, 'evidence', 'discovery');
  const runs = [];
  for (const id of (await readdir(discoveryDir).catch(() => [])).sort()) {
    const summaryFile = JSON.parse(
      await readFile(join(discoveryDir, id, 'summary.json'), 'utf8').catch(() => 'null'),
    );
    if (!summaryFile) continue;
    runs.push({
      runId: id,
      artifact: summaryFile.artifact,
      status: summaryFile.status,
      ...discoveryMetrics(await readJsonl(join(discoveryDir, id, 'events.jsonl'))),
    });
  }
  // Reproducibility: identical capability content apart from identity/provenance.
  const capDir = join(root, 'capabilities');
  const contentDigests: Record<string, string> = {};
  for (const id of await readdir(capDir).catch(() => [])) {
    for (const file of (await readdir(join(capDir, id))).filter((f) => /^v\d+\.json$/.test(f))) {
      const cap = JSON.parse(await readFile(join(capDir, id, file), 'utf8'));
      const { digest: _d, version: _v, provenance: _p, ...content } = cap;
      contentDigests[`${id}/${file}`] = digestOf(content);
    }
  }
  const report = JSON.parse(await readFile(join(root, 'evidence', 'eval', 'report.json'), 'utf8'));
  const cases = report.cases as Array<{
    id: string;
    cohort: string;
    elapsedMs: number;
    verdict: Record<string, unknown> & {
      expectedClass: string;
      actualClass: string;
      correct: boolean;
      falseSuccess: number;
      exactOutputs: boolean;
      exactDisplayedReview: boolean;
      exactLedgerReview: boolean;
    };
  }>;
  const successCases = cases.filter((c) => c.verdict.expectedClass === 'success');
  let journalSource = 'evidence/eval/events.jsonl';
  const replayEvents = await readJsonl(join(root, journalSource)).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    journalSource = 'evidence/eval/runs/*/events.jsonl';
    return (
      await Promise.all(
        cases.map((c) => readJsonl(join(root, 'evidence', 'eval', 'runs', c.id, 'events.jsonl'))),
      )
    ).flat();
  });
  const recordedRuns = new Set(replayEvents.map((event) => event.runId));
  if (cases.some((row) => !recordedRuns.has(row.id)))
    throw new Error('EVALUATION_JOURNAL_INCOMPLETE');
  const steps = stepLatencies(replayEvents);
  if (cases.length && !steps.length) throw new Error('EVALUATION_STEP_TIMING_MISSING');
  const byClass: Record<string, { total: number; correct: number }> = {};
  for (const c of cases) {
    const k = c.verdict.expectedClass;
    byClass[k] ??= { total: 0, correct: 0 };
    byClass[k].total++;
    if (c.verdict.correct) byClass[k].correct++;
  }
  return {
    generatedFrom: [
      'evidence/discovery/*/events.jsonl',
      'evidence/eval/report.json',
      journalSource,
      'capabilities/*/v*.json',
    ],
    discovery: {
      runs,
      reproducibility: {
        distinctArtifacts: new Set(Object.values(contentDigests)).size,
        artifacts: Object.keys(contentDigests).length,
        identical:
          new Set(Object.values(contentDigests)).size === 1 &&
          Object.keys(contentDigests).length > 1,
      },
    },
    replay: {
      cases: cases.length,
      /** Run reported the oracle's expected class (and code, where one is defined). */
      outcomeAccuracy: Number(
        (cases.filter((c) => c.verdict.correct).length / cases.length).toFixed(4),
      ),
      outcomeAccuracyByExpectedClass: byClass,
      /** Success runs whose returned outputs equal the request, the rendered review and the bank's own records. */
      outputFactualAccuracy: Number(
        (
          successCases.filter(
            (c) =>
              c.verdict.exactOutputs &&
              c.verdict.exactDisplayedReview &&
              c.verdict.exactLedgerReview,
          ).length / Math.max(1, successCases.length)
        ).toFixed(4),
      ),
      falseSuccesses: cases.reduce((a, c) => a + c.verdict.falseSuccess, 0),
      hardGates: report.hardGates,
      modelCallsDuringReplay: report.hardGates.modelCalls,
      runLatencyMs: summary(
        cases.filter((c) => c.cohort === 'generalization').map((c) => c.elapsedMs),
      ),
      stepLatencyMs: summary(steps),
      repeatability: report.repeatability,
    },
    training:
      'None. No model is trained or fine-tuned; there are no training metrics. Discovery uses an off-the-shelf model; replay uses no model.',
  };
}

function markdown(m: Awaited<ReturnType<typeof buildMetrics>>): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ms = (s: { p50: number; p95: number; max: number }) =>
    `p50 ${s.p50} ms · p95 ${s.p95} ms · max ${s.max} ms`;
  const lines = [
    '# Metrics',
    '',
    'Computed by `npm run metrics` from saved evidence. Grounding measures rejected unknown element references; acceptance measures decisions accepted by the runtime. Output accuracy requires agreement between returned values, the rendered review, and simulator records.',
    '',
    '## Discovery (model in the loop)',
    '',
  ];
  for (const r of m.discovery.runs) {
    lines.push(
      `### Run ${r.runId}`,
      '',
      '| Measure | Value |',
      '| --- | --- |',
      `| Model calls / decisions | ${r.modelCalls} / ${r.decisions} |`,
      `| Tokens in / out | ${r.tokens.input} / ${r.tokens.output} (per call in: p50 ${r.tokens.inputPerCall.p50}, max ${r.tokens.inputPerCall.max}) |`,
      `| Cost | $${r.costUsd.toFixed(4)} |`,
      `| Model call latency | ${ms(r.callLatencyMs)} |`,
      `| Wall time | ${(r.wallTimeMs / 1000).toFixed(1)} s |`,
      `| Grounding rate | ${pct(r.groundingRate)} |`,
      `| Acceptance rate | ${pct(r.acceptanceRate)} |`,
      `| Executed actions / verified checkpoints / finish | ${r.outcomes.executedActions} / ${r.outcomes.verifiedCheckpoints} / ${r.outcomes.acceptedFinish} |`,
      `| Rejected decisions | ${r.outcomes.rejected} ${JSON.stringify(r.outcomes.rejectedByCode)} |`,
      '',
    );
  }
  const rep = m.discovery.reproducibility;
  lines.push(
    `Reproducibility: ${rep.artifacts} saved artifacts, ${rep.distinctArtifacts} distinct content digest(s)${rep.identical ? ' (independent runs produced identical capabilities)' : ''}.`,
    '',
  );
  const r = m.replay;
  lines.push(
    '## Replay (no model)',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Cases | ${r.cases} |`,
    `| Outcome accuracy | ${pct(r.outcomeAccuracy)} |`,
    `| Output factual accuracy (success cases) | ${pct(r.outputFactualAccuracy)} |`,
    `| False successes | ${r.falseSuccesses} |`,
    `| Model calls during replay | ${r.modelCallsDuringReplay} |`,
    `| Run latency (changed-input cases) | ${ms(r.runLatencyMs)} |`,
    `| Step latency (dispatch → verified checkpoint, ${r.stepLatencyMs.count} steps) | ${ms(r.stepLatencyMs)} |`,
    '',
    'Outcome accuracy by expected class:',
    '',
    ...Object.entries(r.outcomeAccuracyByExpectedClass).map(
      ([k, v]) => `- ${k}: ${v.correct}/${v.total}`,
    ),
    '',
    `Hard gates: ${JSON.stringify(r.hardGates)}`,
    '',
    '## Training',
    '',
    m.training,
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metrics = await buildMetrics();
  await writeFile('evidence/metrics.json', `${JSON.stringify(metrics, null, 2)}\n`);
  await writeFile('evidence/metrics.md', markdown(metrics));
  console.log(markdown(metrics));
}
