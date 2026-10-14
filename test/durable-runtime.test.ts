import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSimulator, DEMO_INPUTS } from '../sim/server.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { launchSurface } from '../src/surface/web.js';
import { digestOf, sealCapability } from '../src/compiler/compile.js';
import { loadProfile } from '../src/profiles.js';
import { createFixtureCapability } from './fixture.js';

let sim: Awaited<ReturnType<typeof startSimulator>>;
let registry: typeof import('../src/registry.js');
let root: string;
let directory: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'durable-runtime-'));
  vi.stubEnv('CAPABILITY_DIR', join(root, 'capabilities'));
  registry = await import('../src/registry.js');
  sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
});
beforeEach(async () => {
  directory = await mkdtemp(join(root, 'worker-'));
  vi.stubEnv('RUN_STATE_DIR', directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await registry.closeRuns();
});
afterAll(async () => {
  await sim?.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('survives a killed worker after an accepted write without repeating the request', async () => {
  const cap = createFixtureCapability();
  const catalog = join(root, 'capabilities', cap.id);
  await mkdir(catalog, { recursive: true });
  await writeFile(join(catalog, 'v1.json'), JSON.stringify(cap));
  // Duplicate invocation checks this built-in profile before consulting its key.
  // The original browser below uses the independent simulator's temporary port.
  await writeFile(
    join(catalog, 'v1.verified.json'),
    JSON.stringify({
      artifactDigest: cap.digest,
      profileDigests: [digestOf(await loadProfile('a'))],
      runtimeDigest: await registry.runtimeFingerprint(),
      runtimeVersion: '0.1.0',
      verifiedAt: new Date().toISOString(),
      source: 'test_fixture',
      evidence: ['test-only'],
    }),
  );
  const runId = randomUUID();
  const requestKey = 'accepted-write-request';
  const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/crash-worker.ts'], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, AWS_BEARER_TOKEN_BEDROCK: '' },
  });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once('exit', (_code, signal) => resolve(signal));
  });
  const accepted = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WORKER_ACCEPT_TIMEOUT')), 20_000);
    child.on('message', (message: { kind?: string }) => {
      clearTimeout(timeout);
      if (message.kind === 'accepted') resolve();
      else reject(new Error('WORKER_DID_NOT_REACH_ACCEPTED_WRITE'));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('WORKER_EXITED_BEFORE_ACCEPTED_WRITE'));
    });
  });
  try {
    child.send({
      directory,
      runId,
      requestKey,
      profile: sim.profiles.a,
      inputs: DEMO_INPUTS,
      cookie: ticket.cookie,
    });
    await accepted;
    expect(sim.inspectSession(ticket.sessionId).draft).toEqual(DEMO_INPUTS);
    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');

    registry.initializeRuntime(directory);
    expect(registry.runStatus(runId)).toMatchObject({
      state: 'interrupted',
      outputsAvailable: false,
      durable: {
        effectStatus: 'unknown',
        pendingActions: [{ stepId: 's9', effect: 'draft' }],
      },
    });
    expect(await registry.invokeSaved(cap.id, { ...DEMO_INPUTS }, 'a', { requestKey })).toEqual({
      runId,
    });
    await expect(
      registry.invokeSaved(cap.id, { ...DEMO_INPUTS }, 'a', {
        requestKey: 'new-request-before-review',
      }),
    ).rejects.toThrow('INTERRUPTED_RUN_REQUIRES_REVIEW');
    expect(registry.listRuns()).toEqual([]);
    const state = sim.inspectSession(ticket.sessionId);
    expect(state.events.filter((event) => event.kind === 'draft_prepared')).toHaveLength(1);
    expect(state.forbiddenCommitCount).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

it('blocks a browser write when its durable intent cannot be saved', async () => {
  const ledger = registry.initializeRuntime(directory);
  const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
  const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
    cookies: [ticket.cookie],
  });
  registry.registerEngine(engine, engine.capability.id, 'a');
  const original = ledger.beginStep.bind(ledger);
  vi.spyOn(ledger, 'beginStep').mockImplementation((runId, stepId, effect) => {
    if (stepId === 's9')
      throw Object.assign(new Error('RUN_STORE_WRITE_FAILED'), {
        code: 'RUN_STORE_WRITE_FAILED',
      });
    return original(runId, stepId, effect);
  });
  expect(await engine.run()).toMatchObject({
    status: 'failed',
    code: 'RUN_STORE_WRITE_FAILED',
    effect: 'none',
  });
  expect(engine.surface.metrics.actionCount).toBe(8);
  const state = sim.inspectSession(ticket.sessionId);
  expect(state.draft).toBeNull();
  expect(state.events.filter((event) => event.kind === 'draft_prepared')).toHaveLength(0);
  expect(state.forbiddenCommitCount).toBe(0);
});

it('keeps an unresolved write interrupted across graceful shutdown and restart', async () => {
  const ledger = registry.initializeRuntime(directory);
  const { digest: _digest, ...base } = createFixtureCapability();
  base.steps.at(-1)!.timeoutMs = 150;
  const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
  const live = await launchSurface({ profile: sim.profiles.a, cookies: [ticket.cookie] });
  const engine = new ReplayEngine(sealCapability(base), { ...DEMO_INPUTS }, sim.profiles.a, {
    page: live.page,
    session: live.session,
  });
  registry.registerEngine(engine, engine.capability.id, 'a');
  try {
    await live.page.route('**/core/application/review', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: '<h1>Processing</h1>' });
    });
    expect(await engine.run()).toMatchObject({
      status: 'escalated',
      reason: 'UNKNOWN_ACTION_OUTCOME',
    });
    expect(ledger.getRecord(engine.runId).pendingActions).toHaveLength(1);
    await registry.closeRuns();
    registry.initializeRuntime(directory);
    expect(registry.runStatus(engine.runId)).toMatchObject({
      state: 'interrupted',
      durable: { effectStatus: 'unknown', code: 'WORKER_STOPPED' },
    });
    expect(
      sim
        .inspectSession(ticket.sessionId)
        .events.filter((event) => event.kind === 'draft_prepared'),
    ).toHaveLength(1);
  } finally {
    await live.close();
  }
});

it('requires review after aborting human control, even with no automated write in flight', async () => {
  const ledger = registry.initializeRuntime(directory);
  const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS, fault: 'session_expired' });
  const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
    cookies: [ticket.cookie],
  });
  registry.registerEngine(engine, engine.capability.id, 'a');
  expect((await engine.run()).status).toBe('escalated');
  await registry.takeoverRun(engine.runId);
  expect(
    ledger.getRecord(engine.runId).pendingActions.some((a) => a.stepId === 'human_control'),
  ).toBe(true);
  await registry.abortRun(engine.runId);
  expect(ledger.getRecord(engine.runId)).toMatchObject({
    state: 'interrupted',
    effectStatus: 'unknown',
  });
  registry.acknowledgeInterruptedRun(engine.runId);
  expect(ledger.getRecord(engine.runId)).toMatchObject({
    state: 'closed',
    effectStatus: 'unknown',
    resolution: { decision: 'abandon', operatorId: 'local_operator' },
  });
});

it('preserves uncertainty when the browser disappears before a requested resume', async () => {
  const ledger = registry.initializeRuntime(directory);
  const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS, fault: 'session_expired' });
  const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
    cookies: [ticket.cookie],
  });
  registry.registerEngine(engine, engine.capability.id, 'a');
  expect((await engine.run()).status).toBe('escalated');
  await engine.surface.page.close();
  expect(await registry.resumeRun(engine.runId)).toMatchObject({
    status: 'failed',
    code: 'SESSION_LOST',
  });
  expect(registry.runStatus(engine.runId)).toMatchObject({ state: 'interrupted' });
  expect(ledger.getRecord(engine.runId).state).toBe('interrupted');
});

it('rejects concurrent resumes while still allowing an operator to abort', async () => {
  registry.initializeRuntime(directory);
  const { operatorManager } = await import('../src/control/manager.js');
  const { loadAccessPolicy } = await import('../src/control/access.js');
  const principal = (await loadAccessPolicy()).principal('local_operator');
  const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS, fault: 'session_expired' });
  const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
    cookies: [ticket.cookie],
  });
  registry.registerEngine(engine, engine.capability.id, 'a');
  expect((await engine.run()).status).toBe('escalated');
  await registry.takeoverRun(engine.runId);
  const epoch = engine.session.epoch;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resume = engine.resume.bind(engine);
  vi.spyOn(engine, 'resume').mockImplementation(async () => {
    entered();
    await blocked;
    return resume();
  });
  const first = operatorManager.control(engine.runId, 'resume', epoch, principal);
  try {
    await started;
    await expect(operatorManager.control(engine.runId, 'resume', epoch, principal)).rejects.toThrow(
      'CONTROL_IN_PROGRESS',
    );
    await operatorManager.control(engine.runId, 'abort', epoch, principal);
    expect(registry.runStatus(engine.runId)).toMatchObject({
      state: 'interrupted',
      durable: { code: 'OPERATOR_ABORTED' },
    });
    await expect(operatorManager.control(engine.runId, 'resume', epoch, principal)).rejects.toThrow(
      'CONTROL_IN_PROGRESS',
    );
  } finally {
    release();
    await first;
  }
});
