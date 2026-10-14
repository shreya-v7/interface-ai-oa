import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReplayEngine } from '../src/replay/engine.js';
import { loadProfile } from '../src/profiles.js';
import type { Principal } from '../src/control/access.js';
import type { RunResult } from '../src/schema/index.js';
import { DEMO_INPUTS } from '../sim/server.js';
import { createFixtureCapability } from './fixture.js';

const agentA: Principal = {
  id: 'agent-a',
  kind: 'service',
  grants: [{ tenant: 'a', role: 'agent' }],
};
const agentB: Principal = {
  id: 'agent-b',
  kind: 'service',
  grants: [{ tenant: 'b', role: 'agent' }],
};
const adminA: Principal = {
  id: 'admin-a',
  kind: 'human',
  grants: [{ tenant: 'a', role: 'admin' }],
};
const adminB: Principal = {
  id: 'admin-b',
  kind: 'human',
  grants: [{ tenant: 'b', role: 'admin' }],
};
const operatorA: Principal = {
  id: 'operator-a',
  kind: 'human',
  grants: [{ tenant: 'a', role: 'operator' }],
};
let root: string;
let directory: string;
let registry: typeof import('../src/registry.js');
let manager: typeof import('../src/control/manager.js');
const capability = createFixtureCapability();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'access-runtime-'));
  vi.stubEnv('CAPABILITY_DIR', join(root, 'capabilities'));
  registry = await import('../src/registry.js');
  manager = await import('../src/control/manager.js');
  await registry.saveCapability(capability);
});
beforeEach(async () => {
  directory = await mkdtemp(join(root, 'runtime-'));
  vi.stubEnv('RUN_STATE_DIR', directory);
  registry.initializeRuntime(directory);
  await registry.markVerified(capability, ['a', 'b'], ['test-only']);
});
afterEach(async () => {
  await registry.closeRuns();
  vi.restoreAllMocks();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** These tests exercise authorization and durable submission, with browser work replaced
 * by an immediate known outcome. The MCP suite exercises the real browser path. */
function successfulExecutor() {
  return vi.spyOn(ReplayEngine.prototype, 'run').mockImplementation(async function (
    this: ReplayEngine,
  ): Promise<RunResult> {
    registry.initializeRuntime().transition(this.runId, 'success');
    return {
      status: 'success',
      runId: this.runId,
      outputs: { ...this.inputs },
      recoveries: [],
      drift: [],
      assisted: false,
    };
  });
}

it('denies unauthorized invocations before lookup, durable registration, or browser execution', async () => {
  const execute = successfulExecutor();
  await expect(
    registry.invokeSaved('missing_capability', { ...DEMO_INPUTS }, 'b', {
      principal: agentA,
      requestKey: 'probe',
    }),
  ).rejects.toThrow('ACCESS_DENIED');
  await expect(
    registry.invokeSaved(capability.id, { ...DEMO_INPUTS }, 'a', {
      principal: operatorA,
      requestKey: 'probe',
    }),
  ).rejects.toThrow('ACCESS_DENIED');
  const engine = new ReplayEngine(capability, { ...DEMO_INPUTS }, await loadProfile('b'));
  try {
    expect(() => registry.registerEngine(engine, capability.id, 'b', undefined, agentA)).toThrow(
      'ACCESS_DENIED',
    );
    expect(registry.durableRuns()).toEqual([]);
    expect(registry.listRuns()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await engine.close();
  }
});

it('namespaces identical request keys by tenant and principal, retaining retries after restart', async () => {
  const execute = successfulExecutor();
  const shared: Principal = {
    id: 'shared-agent',
    kind: 'service',
    grants: [
      { tenant: 'a', role: 'agent' },
      { tenant: 'b', role: 'agent' },
    ],
  };
  const requests = [
    { principal: shared, tenant: 'a' },
    { principal: shared, tenant: 'b' },
    { principal: agentA, tenant: 'a' },
  ] as const;
  const ids: string[] = [];
  for (const request of requests) {
    const result = await registry.invokeSaved(capability.id, { ...DEMO_INPUTS }, request.tenant, {
      requestKey: 'same-request-key',
      principal: request.principal,
    });
    ids.push(result.runId);
    await registry.waitForSettled(result.runId, 1000);
    expect(registry.runStatus(result.runId, request.principal)).toMatchObject({
      state: 'success',
      durable: { tenant: request.tenant, createdBy: request.principal.id },
    });
  }
  expect(new Set(ids).size).toBe(3);
  expect(new Set(registry.durableRuns().map((record) => record.requestKeyDigest)).size).toBe(3);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(() => registry.runStatus(ids[0]!, agentB)).toThrow('RUN_NOT_FOUND');
  expect(() => registry.runStatus('nonexistent-run', agentB)).toThrow('RUN_NOT_FOUND');
  await registry.closeRuns();
  registry.initializeRuntime(directory);
  for (const [index, request] of requests.entries()) {
    expect(
      await registry.invokeSaved(capability.id, { ...DEMO_INPUTS }, request.tenant, {
        requestKey: 'same-request-key',
        principal: request.principal,
      }),
    ).toEqual({ runId: ids[index] });
    expect(registry.runStatus(ids[index]!, request.principal)).toMatchObject({
      outputsAvailable: false,
      state: 'success',
    });
  }
  await expect(
    registry.invokeSaved(capability.id, { ...DEMO_INPUTS, nickname: 'Changed' }, 'a', {
      requestKey: 'same-request-key',
      principal: shared,
    }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  const reduced: Principal = { ...shared, grants: [{ tenant: 'b', role: 'agent' }] };
  await expect(
    registry.invokeSaved(capability.id, { ...DEMO_INPUTS }, 'a', {
      requestKey: 'same-request-key',
      principal: reduced,
    }),
  ).rejects.toThrow('ACCESS_DENIED');
  expect(execute).toHaveBeenCalledTimes(3);
});

it('keeps legacy retry lookup within its tenant while new requests receive an isolated namespace', async () => {
  const execute = successfulExecutor();
  const ledger = registry.initializeRuntime();
  const requestKey = 'pre-sso-request';
  ledger.create({
    runId: 'legacy-a',
    capabilityId: capability.id,
    artifactDigest: capability.digest,
    tenant: 'a',
    requestKeyDigest: ledger.keyFingerprint(requestKey),
    requestFingerprint: ledger.requestFingerprint({
      capabilityId: capability.id,
      artifactDigest: capability.digest,
      tenant: 'a',
      inputs: { ...DEMO_INPUTS },
    }),
  });
  ledger.transition('legacy-a', 'success');
  const b = await registry.invokeSaved(capability.id, { ...DEMO_INPUTS }, 'b', {
    requestKey,
    principal: agentB,
  });
  expect(b.runId).not.toBe('legacy-a');
  await registry.waitForSettled(b.runId, 1000);
  expect(
    await registry.invokeSaved(capability.id, { ...DEMO_INPUTS }, 'a', {
      requestKey,
      principal: agentA,
    }),
  ).toEqual({ runId: 'legacy-a' });
  expect(
    await registry.invokeSaved(capability.id, { ...DEMO_INPUTS }, 'b', {
      requestKey,
      principal: agentB,
    }),
  ).toEqual(b);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(() => registry.runStatus('legacy-a', agentB)).toThrow('RUN_NOT_FOUND');
});

it('preserves tenant permissions after a crash and records the administrator who acknowledges uncertainty', async () => {
  const ledger = registry.initializeRuntime();
  ledger.create({
    runId: 'interrupted-a',
    capabilityId: capability.id,
    artifactDigest: capability.digest,
    tenant: 'a',
    createdBy: agentA.id,
  });
  ledger.beginStep('interrupted-a', 'review-submit', 'draft');
  await registry.closeRuns();
  registry.initializeRuntime(directory);
  expect(registry.runStatus('interrupted-a', agentA)).toMatchObject({
    state: 'interrupted',
    durable: { tenant: 'a', createdBy: 'agent-a', effectStatus: 'unknown' },
  });
  expect(() => registry.runStatus('interrupted-a', agentB)).toThrow('RUN_NOT_FOUND');
  for (const principal of [agentA, agentB, operatorA, adminB]) {
    await expect(
      manager.operatorManager.control('interrupted-a', 'resolve', 0, principal),
    ).rejects.toThrow('ACCESS_DENIED');
  }
  expect(registry.durableRuns()[0]?.state).toBe('interrupted');
  await manager.operatorManager.control('interrupted-a', 'resolve', 0, adminA);
  expect(registry.runStatus('interrupted-a', agentA)).toMatchObject({
    state: 'closed',
    durable: {
      effectStatus: 'unknown',
      resolution: { decision: 'abandon', operatorId: 'admin-a' },
    },
  });
});
