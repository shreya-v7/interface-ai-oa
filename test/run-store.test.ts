import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../src/control/run-store.js';

const directories: string[] = [];
const stores: RunStore[] = [];
const children: ChildProcess[] = [];
const digest = 'a'.repeat(64);
const run = { runId: 'run-1', capabilityId: 'open_savings', artifactDigest: digest, tenant: 'a' };
const moduleUrl = new URL('../src/control/run-store.ts', import.meta.url).href;
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'durable-runs-'));
  directories.push(path);
  return path;
}
function open(path = directory()): RunStore {
  const store = new RunStore(path);
  stores.push(store);
  return store;
}
function child(path: string, program: string): ChildProcess {
  const process = spawn(
    globalThis.process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import {RunStore} from ${JSON.stringify(moduleUrl)};
       const store = new RunStore(${JSON.stringify(path)});
       ${program}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(process);
  return process;
}
async function ready(process: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    process.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('READY')) resolve();
    });
    process.once('exit', () => reject(new Error('CHILD_DID_NOT_START')));
    process.once('error', reject);
  });
}
async function kill(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  process.kill('SIGKILL');
  await exited;
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(kill));
  for (const store of stores.splice(0)) store.dispose();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('durable run store', () => {
  it('writes intent before completion and preserves an unresolved draft during recovery', () => {
    const store = open();
    store.create(run);
    store.beginStep(run.runId, 'prepare', 'draft');
    store.beginStep(run.runId, 'retry-banner', 'read');
    store.completeStep(run.runId, 'retry-banner');
    const record = store.getRecord(run.runId);
    expect(record.pendingActions.map((action) => action.stepId)).toEqual(['prepare']);
    expect(record.effectStatus).toBe('possible');
    expect(() => store.beginStep(run.runId, 'prepare', 'draft')).toThrow(
      'RUN_ACTION_ALREADY_PENDING',
    );
    expect(() => store.transition(run.runId, 'success')).toThrow('RUN_ACTION_PENDING');
    store.completeStep(run.runId, 'prepare');
    expect(store.transition(run.runId, 'success').effectStatus).toBe('confirmed');
    expect(() => store.beginStep(run.runId, 'another', 'read')).toThrow('RUN_NOT_RUNNING');
    expect(() => store.transition(run.runId, 'running')).toThrow('RUN_TERMINAL');
  });

  it('holds one live worker and reconciles a process killed during an uncertain draft', async () => {
    const path = directory();
    const worker = child(
      path,
      `store.create(${JSON.stringify(run)});
       store.beginStep('run-1', 'prepare', 'draft');
       process.stdout.write('READY'); setInterval(() => {}, 1000);`,
    );
    await ready(worker);
    expect(() => new RunStore(path)).toThrow('RUN_WORKER_ACTIVE');
    await kill(worker);
    const recovered = open(path);
    const record = recovered.getRecord(run.runId);
    expect(record.state).toBe('interrupted');
    expect(record.interruptedFrom).toBe('running');
    expect(record.effectStatus).toBe('unknown');
    expect(record.pendingActions).toHaveLength(1);
    expect(() => recovered.beginStep(run.runId, 'prepare', 'draft')).toThrow('RUN_NOT_RUNNING');
    expect(() => recovered.transition(run.runId, 'running')).toThrow('RUN_TERMINAL');
    expect(readdirSync(join(path, '.workers'))).toHaveLength(1);
    const resolved = recovered.resolveInterrupted(run.runId, 'abandon', 'operator');
    expect(resolved.state).toBe('closed');
    expect(resolved.effectStatus).toBe('unknown');
    expect(resolved.resolution?.decision).toBe('abandon');
    expect(() => recovered.resolveInterrupted(run.runId, 'confirmed_complete', 'operator')).toThrow(
      'RUN_NOT_INTERRUPTED',
    );
  });

  it('keeps terminal results and confirmed checkpoints while interrupting all live states', () => {
    const path = directory();
    const initial = open(path);
    for (const runId of ['done', 'checkpoint', 'human', 'read', 'escalated'])
      initial.create({ ...run, runId });
    initial.transition('done', 'success');
    initial.beginStep('checkpoint', 'prepare', 'draft');
    initial.completeStep('checkpoint', 'prepare');
    initial.transition('human', 'human');
    initial.beginStep('read', 'search', 'read');
    initial.transition('escalated', 'escalated', 'UNKNOWN_MODAL');
    initial.dispose();
    const recovered = open(path);
    expect(recovered.getRecord('done').state).toBe('success');
    expect(recovered.getRecord('checkpoint')).toMatchObject({
      state: 'interrupted',
      effectStatus: 'confirmed',
      pendingActions: [],
    });
    expect(recovered.getRecord('human')).toMatchObject({
      state: 'interrupted',
      effectStatus: 'unknown',
    });
    expect(recovered.getRecord('read')).toMatchObject({
      state: 'interrupted',
      effectStatus: 'none',
    });
    expect(recovered.getRecord('escalated').state).toBe('interrupted');
    const reconciled = recovered.resolveInterrupted(
      'checkpoint',
      'confirmed_complete',
      'operator-2',
    );
    expect(reconciled).toMatchObject({ state: 'closed', effectStatus: 'confirmed' });
    expect(reconciled.state).not.toBe('success');
  });

  it('records human control as a possible write without allowing other human-state dispatch', () => {
    const store = open();
    store.create(run);
    store.transition(run.runId, 'human');
    store.beginStep(run.runId, 'human_control', 'draft');
    expect(store.getRecord(run.runId).effectStatus).toBe('possible');
    expect(() => store.beginStep(run.runId, 'automation', 'read')).toThrow('RUN_NOT_RUNNING');
    store.completeStep(run.runId, 'human_control');
    store.transition(run.runId, 'running');
  });

  it('persists opaque idempotency fingerprints, detects conflicts, and never saves arguments', () => {
    const path = directory();
    const store = open(path);
    const request = {
      capabilityId: run.capabilityId,
      tenant: run.tenant,
      artifactDigest: digest,
      inputs: { memberId: 'SENSITIVE_TEST_MEMBER_778822', amount: 2700 },
    };
    const requestKey = 'SENSITIVE_TEST_REQUEST_KEY_89203';
    const key = store.keyFingerprint(requestKey);
    const fingerprint = store.requestFingerprint(request);
    expect(
      store.requestFingerprint({
        ...request,
        inputs: { amount: 2700, memberId: request.inputs.memberId },
      }),
    ).toBe(fingerprint);
    expect(store.requestFingerprint({ ...request, tenant: 'b' })).not.toBe(fingerprint);
    expect(
      store.requestFingerprint({ ...request, inputs: { ...request.inputs, amount: 2701 } }),
    ).not.toBe(fingerprint);
    store.create({ ...run, requestKeyDigest: key, requestFingerprint: fingerprint });
    expect(store.findByRequestKey(key)?.runId).toBe(run.runId);
    expect(() =>
      store.create({
        ...run,
        runId: 'other',
        requestKeyDigest: key,
        requestFingerprint: fingerprint,
      }),
    ).toThrow('RUN_REQUEST_KEY_EXISTS');
    expect(() => store.create({ ...run, runId: 'bad', requestKeyDigest: key })).toThrow();
    const saved = readFileSync(join(path, 'runs.json'), 'utf8');
    expect(saved).not.toContain(requestKey);
    expect(saved).not.toContain(request.inputs.memberId);
    expect(saved).not.toContain('2700');
    expect(statSync(join(path, 'runs.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, 'fingerprint.key')).mode & 0o777).toBe(0o600);
    store.dispose();
    const recovered = open(path);
    expect(recovered.keyFingerprint(requestKey)).toBe(key);
    expect(recovered.requestFingerprint(request)).toBe(fingerprint);
    expect(recovered.findByRequestKey(key)?.state).toBe('interrupted');
    const unrelated = open();
    expect(unrelated.keyFingerprint(requestKey)).not.toBe(key);
  });

  it('returns isolated copies and rejects unsupported fingerprint input types', () => {
    const store = open();
    store.create(run);
    store.getRecord(run.runId).state = 'success';
    store.list()[0]!.pendingActions.push({
      stepId: 'fake',
      effect: 'draft',
      startedAt: new Date().toISOString(),
    });
    expect(store.getRecord(run.runId)).toMatchObject({ state: 'running', pendingActions: [] });
    expect(() => store.getRecord('missing')).toThrow('RUN_NOT_FOUND');
    const request = { capabilityId: run.capabilityId, tenant: 'a', artifactDigest: digest };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [undefined, NaN, Infinity, new Date(), cycle])
      expect(() => store.requestFingerprint({ ...request, inputs: { value } })).toThrow(
        'INVALID_RUN_INPUTS',
      );
    expect(() => store.keyFingerprint('')).toThrow('INVALID_REQUEST_KEY');
  });

  it.each(['invalid-json', 'unexpected-field', 'duplicate-id', 'impossible-success'])(
    'fails closed for a corrupt snapshot: %s',
    (corruption) => {
      const path = directory();
      const store = open(path);
      store.create(run);
      store.dispose();
      const file = join(path, 'runs.json');
      const snapshot = JSON.parse(readFileSync(file, 'utf8'));
      if (corruption === 'invalid-json') writeFileSync(file, '{');
      else {
        if (corruption === 'unexpected-field') snapshot.runs[0].inputs = { private: 'value' };
        if (corruption === 'duplicate-id') snapshot.runs.push(snapshot.runs[0]);
        if (corruption === 'impossible-success') {
          snapshot.runs[0].state = 'success';
          snapshot.runs[0].pendingActions = [
            { stepId: 'pending', effect: 'draft', startedAt: new Date().toISOString() },
          ];
        }
        writeFileSync(file, JSON.stringify(snapshot));
      }
      expect(() => new RunStore(path)).toThrow('RUN_STORE_CORRUPT');
      expect(readdirSync(join(path, '.workers'))).toHaveLength(0);
    },
  );

  it('never silently rotates a missing fingerprint secret or removes an unrecognized lock', () => {
    const path = directory();
    open(path).dispose();
    rmSync(join(path, 'fingerprint.key'));
    expect(() => new RunStore(path)).toThrow('RUN_STORE_SECRET_MISSING');
    expect(existsSync(join(path, 'fingerprint.key'))).toBe(false);
    mkdirSync(join(path, '.workers', 'not-a-worker'));
    expect(() => new RunStore(path)).toThrow('RUN_LOCK_CORRUPT');
    expect(existsSync(join(path, '.workers', 'not-a-worker'))).toBe(true);
  });

  it('poisons the worker after a snapshot write failure and requires reopening', () => {
    const path = directory();
    const store = open(path);
    store.create(run);
    const saved = readFileSync(join(path, 'runs.json'));
    rmSync(join(path, 'runs.json'));
    mkdirSync(join(path, 'runs.json'));
    expect(() => store.beginStep(run.runId, 'prepare', 'draft')).toThrow('RUN_STORE_WRITE_FAILED');
    rmSync(join(path, 'runs.json'), { recursive: true });
    writeFileSync(join(path, 'runs.json'), saved);
    expect(() => store.beginStep(run.runId, 'prepare', 'draft')).toThrow('RUN_STORE_UNAVAILABLE');
    expect(() => store.getRecord(run.runId)).toThrow('RUN_STORE_UNAVAILABLE');
    store.dispose();
    expect(open(path).getRecord(run.runId).state).toBe('interrupted');
  });

  it('never grants ownership to two simultaneous processes', async () => {
    const path = directory();
    const workers = Array.from({ length: 4 }, () =>
      child(path, "process.stdout.write('READY'); setInterval(() => {}, 1000);"),
    );
    const outcomes = await Promise.all(
      workers.map((worker) =>
        ready(worker).then(
          () => true,
          () => false,
        ),
      ),
    );
    expect(outcomes.filter(Boolean).length).toBeLessThanOrEqual(1);
    for (const worker of workers) await kill(worker);
    expect(open(path).list()).toEqual([]);
  });
});
