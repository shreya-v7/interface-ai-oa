import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSimulator, DEMO_INPUTS } from '../sim/server.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { createFixtureCapability } from './fixture.js';

// Regressions found by the runtime red-team review.

describe('CLI input handling', () => {
  // --fixture keeps output under .runs/fixture-demos, so this never touches evidence/.
  const evidence = join('.runs', 'fixture-demos', 'slow_load-b');
  let dir: string;
  const run = (inputFile: string) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'demo:replay',
        '--headless',
        '--fixture',
        '--tenant',
        'b',
        '--scenario',
        'slow_load',
        '--input',
        inputFile,
      ],
      { encoding: 'utf8', env: { ...process.env, RUN_STATE_DIR: join(dir, 'runtime') } },
    );
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-input-'));
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'previous-run.txt'), 'evidence from an earlier run\n');
  });
  afterAll(async () => {
    await rm(evidence, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects inputs that fail the capability schema before clearing earlier evidence', async () => {
    const file = join(dir, 'extra-field.json');
    await writeFile(file, JSON.stringify({ ...DEMO_INPUTS, commit: true }));
    const result = run(file);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('INVALID_INPUTS');
    expect(existsSync(join(evidence, 'previous-run.txt'))).toBe(true);
  });

  it('reports malformed JSON without echoing the file contents', async () => {
    const file = join(dir, 'malformed.json');
    await writeFile(file, 'x481516 Zebra Quokka');
    const result = run(file);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('INVALID_INPUT_JSON');
    expect(result.stderr + result.stdout).not.toMatch(/481516|Zebra|Quokka/);
    expect(existsSync(join(evidence, 'previous-run.txt'))).toBe(true);
  });

  it('names a missing input file instead of suggesting a different capability', () => {
    const result = run(join(dir, 'does-not-exist.json'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('INPUT_FILE_NOT_FOUND');
    expect(result.stderr).not.toContain('--fixture');
  });
});

describe('effect classification and the durable ledger', () => {
  let sim: Awaited<ReturnType<typeof startSimulator>>;
  beforeAll(async () => {
    sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
  });
  afterAll(async () => sim.close());

  it('settles read-only failures and business outcomes without blocking later runs', async () => {
    const { registerEngine, initializeRuntime, durableRuns, closeRuns } =
      await import('../src/registry.js');
    const dir = await mkdtemp(join(tmpdir(), 'effect-'));
    initializeRuntime(join(dir, 'runtime'));
    const replay = async (fault: 'permission_denied' | 'validation_min_deposit' | 'none') => {
      const ticket = sim.createSession({ tenant: 'a', fault, inputs: DEMO_INPUTS });
      const engine = new ReplayEngine(
        createFixtureCapability(),
        { ...DEMO_INPUTS },
        sim.profiles.a,
        {
          cookies: [ticket.cookie],
          headless: true,
        },
      );
      const entry = registerEngine(engine, 'fixture', 'a');
      try {
        return { result: await engine.run(), runId: entry.runId };
      } finally {
        await engine.close();
      }
    };
    try {
      // Permission is denied on a read-only navigation: nothing could have been written.
      const denied = await replay('permission_denied');
      expect(denied.result).toMatchObject({
        status: 'failed',
        code: 'PERMISSION_DENIED',
        effect: 'none',
      });
      const deniedRecord = durableRuns().find((r) => r.runId === denied.runId)!;
      expect(deniedRecord.state).toBe('failed');
      expect(deniedRecord.pendingActions).toEqual([]);

      // The application answered the draft submission with a validation outcome.
      const rejected = await replay('validation_min_deposit');
      expect(rejected.result).toMatchObject({
        status: 'business_outcome',
        code: 'VALIDATION_REJECTED',
      });
      const rejectedRecord = durableRuns().find((r) => r.runId === rejected.runId)!;
      expect(rejectedRecord.state).toBe('business_outcome');
      expect(rejectedRecord.pendingActions).toEqual([]);

      // Neither outcome requires operator review, so the next run starts normally.
      expect((await replay('none')).result.status).toBe('success');
      expect(durableRuns().some((r) => r.state === 'interrupted')).toBe(false);
    } finally {
      await closeRuns();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('stopping the worker with an escalated run', () => {
  let sim: Awaited<ReturnType<typeof startSimulator>>;
  beforeAll(async () => {
    sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
  });
  afterAll(async () => sim.close());

  it('settles a run that escalated before any write instead of requiring review', async () => {
    const { registerEngine, initializeRuntime, durableRuns, closeRuns } =
      await import('../src/registry.js');
    const dir = await mkdtemp(join(tmpdir(), 'stop-'));
    const runtime = join(dir, 'runtime');
    try {
      initializeRuntime(runtime);
      const ticket = sim.createSession({
        tenant: 'a',
        fault: 'ambiguous_duplicate_button',
        inputs: DEMO_INPUTS,
      });
      const engine = new ReplayEngine(
        createFixtureCapability(),
        { ...DEMO_INPUTS },
        sim.profiles.a,
        {
          cookies: [ticket.cookie],
          headless: true,
        },
      );
      const entry = registerEngine(engine, 'fixture', 'a');
      expect(await engine.run()).toMatchObject({ status: 'escalated', reason: 'AMBIGUOUS_TARGET' });
      // The CLI exits here, as `demo:replay --scenario ambiguous_duplicate_button` does.
      await closeRuns();

      initializeRuntime(runtime);
      const stopped = durableRuns().find((r) => r.runId === entry.runId)!;
      expect(stopped).toMatchObject({ state: 'failed', code: 'WORKER_STOPPED' });
      expect(stopped.pendingActions).toEqual([]);
      // The next run is not blocked by a review requirement.
      const next = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
      const engine2 = new ReplayEngine(
        createFixtureCapability(),
        { ...DEMO_INPUTS },
        sim.profiles.a,
        {
          cookies: [next.cookie],
          headless: true,
        },
      );
      registerEngine(engine2, 'fixture', 'a');
      expect((await engine2.run()).status).toBe('success');
      await engine2.close();
    } finally {
      await closeRuns();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
