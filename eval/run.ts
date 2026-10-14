import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSimulator, type ApplicationInputs, type Fault } from '../sim/server.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { CapabilitySchema, type Capability } from '../src/schema/index.js';
import { digestOf } from '../src/compiler/compile.js';
import { loadLatestVerified, runtimeFingerprint } from '../src/registry.js';
import { createFixtureCapability } from '../fixtures/capability.js';
import { buildEpisodes, SCENARIOS } from './scenarios.js';
import { evaluateResult, inspectDisplayedReview, type OracleFacts } from './oracle.js';
import { summarize, saveReport, type CaseReport } from './report.js';
import { containsSentinel } from './privacy.js';

async function leakCount(directory: string, values: string[]): Promise<number> {
  let count = 0;
  for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, item.name);
    if (item.isDirectory()) count += await leakCount(path, values);
    else if (/\.(json|jsonl|txt|md)$/.test(item.name)) {
      const text = await readFile(path, 'utf8');
      for (const value of values) if (containsSentinel(text, value)) count++;
    }
  }
  return count;
}

/** Compact only after every case has been judged and its evidence scanned. */
async function consolidateEvidence(directory: string, cases: CaseReport[]): Promise<void> {
  const journals: string[] = [];
  const representatives = new Set<string>();
  const diagnostics = new Set([
    'failure-structure.json',
    'failure.png',
    'intervention.json',
    'intervention.png',
  ]);
  for (const row of cases) {
    const runDir = join(directory, 'runs', row.id);
    const journal = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    const lines = journal.split('\n').filter(Boolean);
    if (!lines.length || lines.some((line) => JSON.parse(line).runId !== row.id))
      throw new Error('EVALUATION_JOURNAL_INVALID');
    journals.push(journal.endsWith('\n') ? journal : `${journal}\n`);

    const key = `${row.tenant}:${row.scenario}`;
    const keep =
      row.cohort === 'handoff' || (row.cohort === 'generalization' && !representatives.has(key));
    if (row.cohort === 'generalization') representatives.add(key);
    if (!keep) continue;
    for (const file of await readdir(runDir)) {
      if (!diagnostics.has(file)) continue;
      const target = join(directory, 'diagnostics', row.id);
      await mkdir(target, { recursive: true });
      await copyFile(join(runDir, file), join(target, file));
    }
  }
  const temporary = join(directory, 'events.jsonl.tmp');
  await writeFile(temporary, journals.join(''), { mode: 0o600 });
  await rename(temporary, join(directory, 'events.jsonl'));
  await rm(join(directory, 'runs'), { recursive: true });
}
export async function evaluateCapability(
  capability: Capability,
  options: {
    repeats?: number;
    outDir?: string;
    onProgress?: (done: number, total: number) => void;
  } = {},
) {
  const outDir =
    options.outDir ??
    `evidence/${capability.provenance.source === 'live' ? 'eval' : 'fixture-eval'}`;
  // Keep previous attempts intact; never mix appended journals with a new report.
  if ((await readdir(outDir).catch(() => [])).length) {
    await mkdir('.runs', { recursive: true });
    await rename(outDir, join('.runs', `superseded-evaluation-${randomUUID()}`));
  }
  await mkdir(outDir, { recursive: true });
  const runtimeDigest = await runtimeFingerprint();
  const evaluationDigest = digestOf(
    await Promise.all(
      ['run.ts', 'oracle.ts', 'scenarios.ts', 'report.ts', 'privacy.ts'].map(async (file) => [
        file,
        await readFile(new URL(file, import.meta.url), 'utf8'),
      ]),
    ),
  );
  const sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
  const cases: CaseReport[] = [];
  const episodes = buildEpisodes(options.repeats ?? 5);
  const originalFetch = globalThis.fetch;
  let inferenceAttempts = 0;
  let infraRetries = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/bedrock|api\.openai|anthropic\.com/.test(new URL(url).hostname)) {
      inferenceAttempts++;
      throw new Error('INFERENCE_FORBIDDEN_DURING_EVALUATION');
    }
    return originalFetch(input, init);
  };
  try {
    for (const [index, episode] of episodes.entries()) {
      // A browser that never launched dispatched nothing, so one retry with a fresh
      // session is safe. Retries are counted in the report, never hidden.
      for (let attempt = 0; attempt < 2; attempt++) {
        const ticket = sim.createSession({
          tenant: episode.tenant,
          fault: episode.scenario.id as Fault,
          inputs: episode.inputs as unknown as ApplicationInputs,
        });
        const directory = join(outDir, 'runs', episode.id);
        if (attempt > 0) await rm(directory, { recursive: true, force: true });
        const engine = new ReplayEngine(capability, episode.inputs, sim.profiles[episode.tenant], {
          cookies: [ticket.cookie],
          headless: true,
          runId: episode.id,
          journalPath: join(directory, 'events.jsonl'),
          evidenceDir: directory,
        });
        const start = Date.now(),
          beforeInference = inferenceAttempts;
        try {
          const result = await engine.run();
          if (!engine.surface && attempt === 0) {
            infraRetries++;
            continue;
          }
          const metrics = engine.surface?.metrics ?? {
            unsafeDispatch: 0,
            actionCount: 0,
            actionSequence: [],
          };
          const inspection = sim.inspectSession(ticket.sessionId);
          let displayedReview: OracleFacts['displayedReview'],
            reviewParsingError = false;
          try {
            displayedReview = await inspectDisplayedReview(
              engine.surface.page,
              sim.profiles[episode.tenant].labelAliases as never,
            );
          } catch {
            reviewParsingError = true;
          }
          const observed =
            episode.scenario.expected === 'success'
              ? inspection.currentScreen === 'review'
              : episode.scenario.id === 'member_not_found'
                ? inspection.currentScreen === 'not_found'
                : episode.scenario.id === 'validation_min_deposit'
                  ? inspection.currentScreen === 'validation'
                  : episode.scenario.id === 'ambiguous_duplicate_button'
                    ? inspection.currentScreen === 'detail'
                    : episode.scenario.id === 'session_expired'
                      ? inspection.currentScreen === 'session_expired'
                      : episode.scenario.id.startsWith('wrong_')
                        ? inspection.currentScreen === 'review'
                        : inspection.currentScreen === 'permission_denied';
          const facts: OracleFacts = {
            ledgerReview: inspection.draft ?? undefined,
            displayedReview,
            reviewParsingError,
            scenarioObserved: observed,
            forbiddenEffects: inspection.forbiddenCommitCount,
            unsafeDispatches: metrics.unsafeDispatch,
            modelCalls: inferenceAttempts - beforeInference,
            leaks: await leakCount(directory, [
              String(episode.inputs.memberId),
              String(episode.inputs.nickname),
              (Number(episode.inputs.openingDepositMinor) / 100).toFixed(2),
            ]),
            telemetryComplete: metrics.actionCount > 0,
          };
          const verdict = evaluateResult(episode.scenario, episode.inputs, result, facts);
          cases.push({
            id: episode.id,
            cohort: episode.cohort,
            tenant: episode.tenant,
            scenario: episode.scenario.id,
            seed: episode.seed,
            elapsedMs: Date.now() - start,
            actionHash: digestOf(metrics.actionSequence),
            actionCount: metrics.actionCount,
            infraRetried: attempt > 0,
            recoveries: engine.recoveries.length,
            verdict,
          });
        } finally {
          await engine.close();
        }
        break;
      }
      options.onProgress?.(index + 1, episodes.length);
    }
    // This is a scripted operator exercising the real lease and existing page.
    for (const tenant of ['a', 'b'] as const) {
      const inputs = {
        memberId: '654321',
        productCode: 'SAV-HY' as const,
        nickname: 'Handoff sentinel',
        openingDepositMinor: 12345,
      };
      const id = `${tenant}-scripted-handoff`;
      const dir = join(outDir, 'runs', id);
      const start = () => {
        const t = sim.createSession({ tenant, fault: 'session_expired', inputs });
        const e = new ReplayEngine(capability, inputs, sim.profiles[tenant], {
          cookies: [t.cookie],
          runId: id,
          journalPath: join(dir, 'events.jsonl'),
          evidenceDir: dir,
        });
        return { ticket: t, engine: e };
      };
      let { ticket, engine } = start();
      const started = Date.now(),
        beforeInference = inferenceAttempts;
      try {
        let initial = await engine.run();
        if (!engine.surface) {
          // Browser never launched, nothing dispatched: one counted retry.
          infraRetries++;
          await engine.close();
          await rm(dir, { recursive: true, force: true });
          ({ ticket, engine } = start());
          initial = await engine.run();
        }
        if (initial.status !== 'escalated') throw new Error('HANDOFF_NOT_TRIGGERED');
        const page = engine.surface.page,
          context = page.context(),
          oldEpoch = engine.session.epoch;
        await engine.takeover('test_operator');
        const frame = page
          .frames()
          .find((f) => f.name() === sim.profiles[tenant].frameAliases.content)!;
        await frame.getByLabel('Operator code').fill('demo-unlock');
        await frame.getByRole('button', { name: 'Resume session' }).click();
        await frame.getByRole('heading', { name: 'Savings application', exact: true }).waitFor();
        let staleAccepted = false;
        await engine.session
          .dispatch(oldEpoch, async () => {
            staleAccepted = true;
          })
          .catch(() => {});
        const result = await engine.resume();
        const inspection = sim.inspectSession(ticket.sessionId);
        const displayedReview = await inspectDisplayedReview(
          page,
          sim.profiles[tenant].labelAliases as never,
        );
        const verdict = evaluateResult(SCENARIOS[0]!, inputs, result, {
          ledgerReview: inspection.draft ?? undefined,
          displayedReview,
          scenarioObserved: inspection.events.some((e) => e.kind === 'session_restored'),
          forbiddenEffects: inspection.forbiddenCommitCount,
          unsafeDispatches: engine.surface.metrics.unsafeDispatch,
          modelCalls: inferenceAttempts - beforeInference,
          ownershipViolations: Number(staleAccepted),
          leaks: await leakCount(dir, [inputs.memberId, inputs.nickname, '123.45']),
          telemetryComplete: true,
        });
        cases.push({
          id,
          cohort: 'handoff',
          tenant,
          scenario: 'session_expired',
          seed: 0,
          elapsedMs: Date.now() - started,
          actionHash: digestOf(engine.surface.metrics.actionSequence),
          actionCount: engine.surface.metrics.actionCount,
          recoveries: engine.recoveries.length,
          verdict,
          operator: 'scripted_test_operator',
          sameSessionPreserved:
            page === engine.surface.page && context === engine.surface.page.context(),
        });
      } finally {
        await engine.close();
      }
    }
    const report = summarize(cases, capability.digest, infraRetries);
    if (runtimeDigest !== (await runtimeFingerprint()))
      throw new Error('RUNTIME_CHANGED_DURING_EVALUATION');
    await consolidateEvidence(outDir, cases);
    await saveReport(report, outDir);
    await writeFile(
      join(outDir, 'provenance.json'),
      JSON.stringify(
        {
          source: capability.provenance.source,
          capabilityDigest: capability.digest,
          runtimeDigest,
          evaluationDigest,
          profileDigests: Object.values(sim.profiles).map(digestOf),
          scenarioDigest: digestOf(SCENARIOS),
          suite: '2-tenants-12-scenarios-5-variants-plus-fixed-and-handoff',
          modelUsed: false,
        },
        null,
        2,
      ),
    );
    return report;
  } finally {
    globalThis.fetch = originalFetch;
    await sim.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = process.argv.includes('--fixture');
  const pathIndex = process.argv.indexOf('--artifact');
  const capability = fixture
    ? createFixtureCapability()
    : pathIndex >= 0
      ? CapabilitySchema.parse(JSON.parse(await readFile(process.argv[pathIndex + 1]!, 'utf8')))
      : await loadLatestVerified('open_savings_subaccount_to_review');
  console.log(
    `Evaluating ${capability.provenance.source === 'live' ? 'live-discovered capability' : 'HANDWRITTEN TEST FIXTURE - not discovery evidence'}`,
  );
  const result = await evaluateCapability(capability, {
    onProgress: (done, total) => {
      if (done % 10 === 0) console.log(`${done}/${total} replay episodes`);
    },
  });
  console.log(
    JSON.stringify(
      { passed: result.passed, counts: result.counts, hardGates: result.hardGates },
      null,
      2,
    ),
  );
  if (!result.passed) process.exitCode = 1;
}
