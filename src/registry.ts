import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CapabilitySchema,
  RunResultSchema,
  type Capability,
  type Inputs,
  type RunResult,
  validateInputs,
} from './schema/index.js';
import { digestOf, validateReferences } from './compiler/compile.js';
import { loadProfile } from './profiles.js';
import { ReplayEngine } from './replay/engine.js';
import { RunStore, type RunRecord } from './control/run-store.js';
import { can, PrincipalSchema, requirePermission, type Principal } from './control/access.js';

const ROOT = process.env.CAPABILITY_DIR ?? 'capabilities';
export interface Verification {
  artifactDigest: string;
  profileDigests: string[];
  runtimeDigest: string;
  runtimeVersion: '0.1.0';
  verifiedAt: string;
  evidence: string[];
  source: 'live' | 'test_fixture';
}
const VerificationSchema = z
  .object({
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    profileDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
    runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeVersion: z.literal('0.1.0'),
    verifiedAt: z.iso.datetime(),
    evidence: z.array(z.string().min(1)).min(1),
    source: z.enum(['live', 'test_fixture']),
  })
  .strict();
export async function runtimeFingerprint(): Promise<string> {
  const files = [
    'src/schema/index.ts',
    'src/schema/money.ts',
    'src/compiler/compile.ts',
    'src/registry.ts',
    'src/replay/engine.ts',
    'src/surface/web.ts',
    'src/control/session.ts',
    'src/control/run-store.ts',
    'src/control/auth.ts',
    'src/control/access.ts',
    'src/control/oidc.ts',
    'src/control/operator-config.ts',
    'src/control/operator-server.ts',
    'src/control/manager.ts',
    'src/mcp/server.ts',
    'src/policy/gate.ts',
    'src/policy/network-guard.ts',
    'src/policy/events.ts',
    'vendor/legacy-core/policy.json',
    'vendor/legacy-core/exceptions.json',
    'config/access.json',
  ];
  return digestOf(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(new URL(`../${file}`, import.meta.url), 'utf8'),
      ]),
    ),
  );
}
function safeId(id: string) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) throw new Error('INVALID_CAPABILITY_ID');
  return id;
}
export async function saveCapability(cap: Capability): Promise<string> {
  validateReferences(cap);
  const dir = join(ROOT, safeId(cap.id));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `v${cap.version}.json`);
  await writeFile(path, `${JSON.stringify(cap, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}
export async function markVerified(
  cap: Capability,
  profileIds: string[],
  evidence: string[],
): Promise<void> {
  validateReferences(cap);
  if (!evidence.length) throw new Error('VERIFICATION_EVIDENCE_REQUIRED');
  const profileDigests = await Promise.all(
    profileIds.map(async (id) => digestOf(await loadProfile(id))),
  );
  const record: Verification = {
    artifactDigest: cap.digest,
    profileDigests,
    runtimeDigest: await runtimeFingerprint(),
    runtimeVersion: '0.1.0',
    verifiedAt: new Date().toISOString(),
    evidence,
    source: cap.provenance.source,
  };
  const path = join(ROOT, safeId(cap.id), `v${cap.version}.verified.json`);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
/** All saved versions of a capability, newest first (drafts included). */
export async function savedVersions(id: string): Promise<number[]> {
  safeId(id);
  const files = await readdir(join(ROOT, id)).catch(() => [] as string[]);
  return files
    .map((f) => Number(/^v(\d+)\.json$/.exec(f)?.[1] ?? 0))
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
}
/** Next free version number; drafts that failed verification still occupy theirs. */
export async function nextVersion(id: string): Promise<number> {
  return ((await savedVersions(id))[0] ?? 0) + 1;
}
export async function loadCapability(id: string, version: number): Promise<Capability> {
  safeId(id);
  if (!Number.isInteger(version) || version < 1) throw new Error('INVALID_VERSION');
  const cap = CapabilitySchema.parse(
    JSON.parse(
      await readFile(join(ROOT, id, `v${version}.json`), 'utf8').catch(() => {
        throw new Error('CAPABILITY_NOT_FOUND');
      }),
    ),
  );
  validateReferences(cap);
  if (cap.id !== id || cap.version !== version) throw new Error('ARTIFACT_IDENTITY_MISMATCH');
  return cap;
}
/**
 * The newest version with a current verification record. An unverified draft (for
 * example a re-discovery whose shadow replay failed) never hides a verified version.
 */
export async function loadLatestVerified(id: string): Promise<Capability> {
  const versions = await savedVersions(id);
  if (!versions.length) throw new Error('CAPABILITY_NOT_FOUND');
  for (const version of versions) {
    try {
      const cap = await loadCapability(id, version);
      await verificationFor(cap);
      return cap;
    } catch {
      /* Draft, stale or invalid: try the previous version. */
    }
  }
  throw new Error('CAPABILITY_NOT_VERIFIED');
}
export async function verificationFor(cap: Capability): Promise<Verification> {
  const v = VerificationSchema.parse(
    JSON.parse(
      await readFile(join(ROOT, cap.id, `v${cap.version}.verified.json`), 'utf8').catch(() => {
        throw new Error('CAPABILITY_NOT_VERIFIED');
      }),
    ),
  );
  if (
    v.artifactDigest !== cap.digest ||
    v.source !== cap.provenance.source ||
    v.runtimeVersion !== '0.1.0' ||
    v.runtimeDigest !== (await runtimeFingerprint())
  )
    throw new Error('STALE_VERIFICATION');
  return v;
}
export async function listCapabilities(): Promise<Capability[]> {
  const ids = await readdir(ROOT, { withFileTypes: true }).catch(() => []);
  const caps: Capability[] = [];
  for (const item of ids)
    if (item.isDirectory()) {
      try {
        caps.push(await loadLatestVerified(item.name));
      } catch {
        /* Invalid/draft entries are not callable. */
      }
    }
  return caps;
}
export interface RunEntry {
  runId: string;
  capabilityId: string;
  tenant: string;
  engine: ReplayEngine;
  result?: RunResult;
  state: string;
  startedAt: string;
}
const runs = new Map<string, RunEntry>();
let store: RunStore | undefined;
export function initializeRuntime(
  directory = process.env.RUN_STATE_DIR ?? '.runs/runtime',
): RunStore {
  return (store ??= new RunStore(directory));
}
export function durableRuns(): RunRecord[] {
  return initializeRuntime().list();
}
export function runStatus(runId: string, principal?: Principal) {
  const live = runs.get(runId);
  const record = initializeRuntime().getRecord(runId);
  if (principal && !can(principal, record.tenant, 'read')) throw new Error('RUN_NOT_FOUND');
  if (live)
    return {
      runId,
      state: record.state,
      ...(live.result ? { result: live.result } : {}),
      durable: record,
    };
  return { runId, state: record.state, durable: record, outputsAvailable: false };
}
function acceptResult(entry: RunEntry, result: RunResult): void {
  const parsed = RunResultSchema.parse(result);
  const ledger = initializeRuntime();
  const record = ledger.getRecord(entry.runId);
  // A run already settled (for example stopped at shutdown) keeps its recorded outcome;
  // a late result from aborting its engine must not rewrite it.
  if (record.state !== 'interrupted' && !(TERMINAL as readonly string[]).includes(record.state)) {
    // Review is needed when a write may have happened unseen: a failure whose draft
    // effect is unknown, or any failure after a person controlled the session (their
    // actions are never verified by automation). A business-outcome screen is the
    // application's own answer to the pending request, and a known failure effect is
    // not uncertain, so those settle their pending actions instead of blocking runs.
    const pending = ledger.getRecord(entry.runId).pendingActions;
    const humanUnverified = pending.some((action) => action.stepId === 'human_control');
    const uncertain =
      parsed.status === 'failed' && (parsed.effect === 'unknown' || humanUnverified);
    if (!uncertain && (parsed.status === 'business_outcome' || parsed.status === 'failed'))
      for (const action of pending) ledger.completeStep(entry.runId, action.stepId);
    ledger.transition(
      entry.runId,
      uncertain ? 'interrupted' : parsed.status,
      parsed.status === 'failed' || parsed.status === 'business_outcome'
        ? parsed.code
        : parsed.status === 'escalated'
          ? parsed.reason
          : undefined,
    );
  }
  entry.result = parsed;
  entry.state = parsed.status;
}
export const TERMINAL = ['success', 'failed', 'business_outcome'] as const;
/**
 * Waits until a run reaches a terminal result. An escalated run is still live: an
 * operator may take over and resume it, and `entry.result` is cleared while that
 * resume executes. Callers must therefore wait on state, never on `result` alone.
 */
export async function waitForSettled(runId: string, timeoutMs: number): Promise<RunResult> {
  const entry = getRun(runId);
  const deadline = Date.now() + timeoutMs;
  while (!(TERMINAL as readonly string[]).includes(entry.state) || !entry.result) {
    if (Date.now() >= deadline) throw new Error('OPERATOR_WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return entry.result;
}
export function getRun(id: string): RunEntry {
  const r = runs.get(id);
  if (!r) throw new Error('RUN_NOT_FOUND');
  return r;
}
export function listRuns(): RunEntry[] {
  return [...runs.values()];
}
export function registerEngine(
  engine: ReplayEngine,
  capabilityId: string,
  tenant: string,
  request?: { requestKeyDigest: string; requestFingerprint: string },
  principal?: Principal,
): RunEntry {
  if (principal) requirePermission(principal, tenant, 'invoke');
  const runId = engine.runId;
  const entry: RunEntry = {
    runId,
    capabilityId,
    tenant,
    engine,
    state: 'running',
    startedAt: new Date().toISOString(),
  };
  const ledger = initializeRuntime();
  if (ledger.list().some((record) => record.state === 'interrupted'))
    throw new Error('INTERRUPTED_RUN_REQUIRES_REVIEW');
  ledger.create({
    runId,
    capabilityId,
    artifactDigest: engine.capability.digest,
    tenant,
    ...(principal ? { createdBy: principal.id } : {}),
    ...request,
  });
  engine.attachDurability({
    begin: (stepId, effect) => ledger.beginStep(runId, stepId, effect),
    checkpoint: () => {
      // The runtime is sequential. A verified checkpoint reconciles the current
      // action, its bounded recovery, and any completed live human intervention.
      for (const action of ledger.getRecord(runId).pendingActions)
        ledger.completeStep(runId, action.stepId);
    },
    settle: (result) => acceptResult(entry, result),
  });
  runs.set(runId, entry);
  return entry;
}
export async function invokeSaved(
  id: string,
  inputs: Inputs,
  profileId: string,
  opts: Record<string, unknown> = {},
): Promise<{ runId: string }> {
  const principal =
    opts.principal === undefined ? undefined : PrincipalSchema.parse(opts.principal);
  if (principal) requirePermission(principal, profileId, 'invoke');
  const cap =
    typeof opts.version === 'number'
      ? await loadCapability(id, opts.version)
      : await loadLatestVerified(id);
  const verification = await verificationFor(cap);
  const profile = await loadProfile(profileId);
  if (opts.expectedDigest !== undefined && opts.expectedDigest !== cap.digest)
    throw new Error('STALE_CAPABILITY_HANDLE');
  if (!verification.profileDigests.includes(digestOf(profile)))
    throw new Error('UNVERIFIED_PROFILE');
  validateInputs(cap.inputs, inputs);
  const ledger = initializeRuntime();
  const request =
    typeof opts.requestKey === 'string'
      ? {
          requestKeyDigest: ledger.keyFingerprint(
            principal
              ? JSON.stringify([principal.id, profileId, opts.requestKey])
              : opts.requestKey,
          ),
          requestFingerprint: ledger.requestFingerprint({
            capabilityId: cap.id,
            tenant: profileId,
            artifactDigest: cap.digest,
            inputs,
          }),
        }
      : undefined;
  if (request) {
    // Preserve retries for pre-SSO records without exposing another tenant's key.
    const legacy =
      principal && typeof opts.requestKey === 'string'
        ? ledger.findByRequestKey(ledger.keyFingerprint(opts.requestKey))
        : undefined;
    const previous =
      ledger.findByRequestKey(request.requestKeyDigest) ??
      (legacy && !legacy.createdBy && legacy.tenant === profileId ? legacy : undefined);
    if (previous) {
      if (previous.requestFingerprint !== request.requestFingerprint)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return { runId: previous.runId };
    }
  }
  if (ledger.list().some((r) => r.state === 'interrupted'))
    throw new Error('INTERRUPTED_RUN_REQUIRES_REVIEW');
  const done: readonly string[] = [...TERMINAL, 'closed'];
  if ([...runs.values()].some((r) => !done.includes(r.state))) throw new Error('RUNNER_BUSY');
  const engine = new ReplayEngine(cap, inputs, profile, opts);
  const entry = registerEngine(engine, cap.id, profileId, request, principal);
  void engine
    .run()
    .then(async (r) => {
      entry.result = RunResultSchema.parse(r);
      entry.state = r.status;
      if (r.status !== 'escalated') await engine.close();
    })
    .catch(async () => {
      entry.state = 'failed';
      entry.result = {
        status: 'failed',
        code: 'RUNNER_ERROR',
        runId: entry.runId,
        expected: 'Completed replay',
        observed: 'Runner stopped',
        effect: 'unknown',
        evidence: [],
        assisted: false,
      };
      try {
        ledger.transition(entry.runId, 'interrupted', 'RUNNER_ERROR');
      } catch {
        // Leave the last durable intent intact when storage has failed.
      }
      entry.state = 'interrupted';
      await engine.close();
    });
  return { runId: entry.runId };
}
export async function takeoverRun(id: string): Promise<void> {
  const r = getRun(id);
  const ledger = initializeRuntime();
  ledger.transition(id, 'human');
  await r.engine.takeover();
  if (!ledger.getRecord(id).pendingActions.some((action) => action.stepId === 'human_control'))
    ledger.beginStep(id, 'human_control', 'draft');
  ledger.transition(id, 'human');
  r.state = 'human';
}
export async function resumeRun(id: string): Promise<RunResult> {
  const r = getRun(id);
  const previousResult = r.result;
  r.result = undefined;
  r.state = 'running';
  initializeRuntime().transition(id, 'running');
  try {
    const result = await r.engine.resume();
    acceptResult(r, result);
    if (result.status !== 'escalated') await r.engine.close();
    return result;
  } catch (error) {
    r.state = r.engine.session.state;
    r.result = previousResult;
    if (['running', 'human', 'escalated'].includes(initializeRuntime().getRecord(id).state))
      initializeRuntime().transition(id, 'escalated', 'RESUME_REJECTED');
    throw error;
  }
}
export async function abortRun(id: string): Promise<RunResult> {
  const r = getRun(id);
  const result = await r.engine.abort();
  r.result = result;
  r.state = result.status;
  await r.engine.close();
  return result;
}
export async function closeRuns(): Promise<void> {
  const results = await Promise.allSettled(
    [...runs.values()].map(async (r) => {
      try {
        const unfinished = !(TERMINAL as readonly string[]).includes(r.state);
        if (unfinished) {
          const ledger = initializeRuntime();
          const record = ledger.getRecord(r.runId);
          // A stopped run needs review only if a write may have happened unseen: a
          // dispatched draft step or human control (both recorded as pending drafts).
          // Otherwise nothing could have changed, so it settles as a plain stop.
          const unverifiedWrite = record.pendingActions.some((action) => action.effect === 'draft');
          if (record.state !== 'interrupted') {
            if (unverifiedWrite) ledger.transition(r.runId, 'interrupted', 'WORKER_STOPPED');
            else {
              for (const action of record.pendingActions)
                ledger.completeStep(r.runId, action.stepId);
              ledger.transition(r.runId, 'failed', 'WORKER_STOPPED');
            }
          }
          await r.engine.abort();
          r.state = unverifiedWrite ? 'interrupted' : 'failed';
        }
      } finally {
        await r.engine.close();
      }
    }),
  );
  try {
    runs.clear();
    store?.dispose();
  } finally {
    store = undefined;
  }
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('RUN_SHUTDOWN_REQUIRES_REVIEW');
}
export function acknowledgeInterruptedRun(id: string, operatorId = 'local_operator'): void {
  initializeRuntime().resolveInterrupted(id, 'abandon', operatorId);
}
