import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Verdict } from './oracle.js';

export interface CaseReport {
  id: string;
  cohort: 'generalization' | 'repeatability' | 'handoff';
  tenant: 'a' | 'b';
  scenario: string;
  seed: number;
  elapsedMs: number;
  actionHash: string;
  actionCount: number;
  recoveries: number;
  verdict: Verdict;
  operator?: 'scripted_test_operator';
  /** The first attempt's browser never launched (nothing dispatched); this is the retry. */
  infraRetried?: boolean;
  sameSessionPreserved?: boolean;
}
export interface EvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  capabilityDigest: string;
  counts: {
    total: number;
    generalization: number;
    repeatability: number;
    handoff: number;
    correct: number;
    validCases: number;
    validSuccesses: number;
    infraRetries: number;
  };
  hardGates: {
    falseSuccess: number;
    unsafeDispatches: number;
    forbiddenEffects: number;
    modelCalls: number;
    ownershipViolations: number;
    leaks: number;
  };
  /** Number of cases in which each hard gate was actually measured. */
  gateCoverage: Record<string, number>;
  confusion: Record<string, Record<string, number>>;
  latencyMs: { p50: number; p95: number };
  repeatability: Array<{
    tenant: string;
    runs: number;
    distinctActionHashes: number;
    distinctOutcomes: number;
    stable: boolean;
  }>;
  passed: boolean;
  cases: CaseReport[];
}
export function summarize(
  cases: CaseReport[],
  capabilityDigest: string,
  infraRetries = 0,
): EvaluationReport {
  const generalization = cases.filter((row) => row.cohort === 'generalization');
  const valid = generalization.filter((row) => row.verdict.expectedClass === 'success');
  const hardGates = {
    falseSuccess: 0,
    unsafeDispatches: 0,
    forbiddenEffects: 0,
    modelCalls: 0,
    ownershipViolations: 0,
    leaks: 0,
  };
  const gateCoverage: Record<string, number> = { falseSuccess: cases.length };
  const confusion: Record<string, Record<string, number>> = {};
  for (const row of cases) {
    hardGates.falseSuccess += row.verdict.falseSuccess;
    for (const key of row.verdict.measured) gateCoverage[key] = (gateCoverage[key] ?? 0) + 1;
    for (const key of Object.keys(row.verdict.violations) as Array<keyof Verdict['violations']>)
      hardGates[key] += row.verdict.violations[key];
    if (row.cohort !== 'generalization') continue;
    const expected = row.verdict.expectedClass,
      actual = row.verdict.actualClass;
    confusion[expected] ??= {};
    confusion[expected]![actual] = (confusion[expected]![actual] ?? 0) + 1;
  }
  const latencies = generalization.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const quantile = (p: number) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? 0;
  const repeatability = (['a', 'b'] as const).map((tenant) => {
    const rows = cases.filter((row) => row.cohort === 'repeatability' && row.tenant === tenant);
    const distinctActionHashes = new Set(rows.map((row) => row.actionHash)).size;
    const distinctOutcomes = new Set(
      rows.map((row) => `${row.verdict.actualClass}:${row.verdict.correct}`),
    ).size;
    return {
      tenant,
      runs: rows.length,
      distinctActionHashes,
      distinctOutcomes,
      stable:
        rows.length > 1 &&
        distinctActionHashes === 1 &&
        distinctOutcomes === 1 &&
        rows.every((row) => row.verdict.correct),
    };
  });
  const validSuccesses = valid.filter((row) => row.verdict.correct).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    capabilityDigest,
    counts: {
      total: cases.length,
      generalization: generalization.length,
      repeatability: cases.filter((row) => row.cohort === 'repeatability').length,
      handoff: cases.filter((row) => row.cohort === 'handoff').length,
      correct: cases.filter((row) => row.verdict.correct).length,
      validCases: valid.length,
      validSuccesses,
      infraRetries,
    },
    hardGates,
    gateCoverage,
    confusion,
    latencyMs: { p50: quantile(0.5), p95: quantile(0.95) },
    repeatability,
    passed:
      generalization.length === 120 &&
      valid.length > 0 &&
      validSuccesses / valid.length >= 0.95 &&
      Object.values(hardGates).every((n) => n === 0) &&
      cases.every((row) => row.verdict.correct) &&
      cases.filter((row) => row.cohort === 'handoff').length === 2 &&
      cases.filter((row) => row.cohort === 'handoff').every((row) => row.sameSessionPreserved) &&
      repeatability.every((row) => row.stable),
    cases,
  };
}
export function markdown(report: EvaluationReport): string {
  const percentage = report.counts.validCases
    ? `${((100 * report.counts.validSuccesses) / report.counts.validCases).toFixed(1)}%`
    : 'not measured';
  return (
    `# Capability evaluation\n\n${report.passed ? 'PASS' : 'FAIL'} - ${report.counts.correct}/${report.counts.total} cases matched the independent oracle.\n\n` +
    `Artifact digest: \`${report.capabilityDigest}\`\n\n` +
    `${report.counts.generalization} changed-input cases, ${report.counts.repeatability} fixed-input repeats, ${report.counts.handoff} scripted handoffs. Browser-launch retries: ${report.counts.infraRetries}.\n\n` +
    `| Metric | Observed | Measured in |\n| --- | ---: | ---: |\n| Valid task success | ${report.counts.validSuccesses}/${report.counts.validCases} (${percentage}) | - |\n| Replay p50 | ${Math.round(report.latencyMs.p50)} ms | - |\n| Replay p95 | ${Math.round(report.latencyMs.p95)} ms | - |\n` +
    Object.entries(report.hardGates)
      .map(
        ([key, count]) =>
          `| ${key} - required zero | ${count} | ${report.gateCoverage[key] ?? 0} cases |`,
      )
      .join('\n') +
    '\n\n' +
    `Synthetic test results; the judge uses application records, not a model. Unsafe dispatches count policy-approved actions blocked by the network guard. Ownership checks cover deliberate stale actions in the handoff cases.\n\n` +
    `## Outcome confusion counts\n\n| Expected | Reported | Count |\n| --- | --- | ---: |\n` +
    Object.entries(report.confusion)
      .flatMap(([expected, actuals]) =>
        Object.entries(actuals).map(([actual, count]) => `| ${expected} | ${actual} | ${count} |`),
      )
      .join('\n') +
    '\n\n' +
    `## Fixed-input repeatability\n\n| Tenant | Runs | Action hashes | Outcome variants | Stable |\n| --- | ---: | ---: | ---: | --- |\n` +
    report.repeatability
      .map(
        (row) =>
          `| ${row.tenant} | ${row.runs} | ${row.distinctActionHashes} | ${row.distinctOutcomes} | ${row.stable} |`,
      )
      .join('\n') +
    '\n\nFull case verdicts: [report.json](report.json). Run events: [events.jsonl](events.jsonl).\n'
  );
}
export async function saveReport(report: EvaluationReport, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(directory, 'report.md'), markdown(report));
}
