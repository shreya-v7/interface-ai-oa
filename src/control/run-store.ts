import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const StateSchema = z.enum([
  'running',
  'escalated',
  'human',
  'success',
  'business_outcome',
  'failed',
  'interrupted',
  'closed',
]);
export type DurableRunState = z.infer<typeof StateSchema>;
export type DurableEffect = 'read' | 'draft';
export type ResolutionDecision = 'abandon' | 'confirmed_complete';
const PendingSchema = z
  .object({ stepId: Identifier, effect: z.enum(['read', 'draft']), startedAt: z.iso.datetime() })
  .strict();
export const RunRecordSchema = z
  .object({
    runId: Identifier,
    capabilityId: Identifier,
    artifactDigest: Digest,
    tenant: Identifier,
    createdBy: Identifier.optional(),
    requestKeyDigest: Digest.optional(),
    requestFingerprint: Digest.optional(),
    state: StateSchema,
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    stepId: Identifier.optional(),
    pendingActions: z.array(PendingSchema).max(256),
    effectStatus: z.enum(['none', 'possible', 'confirmed', 'unknown']),
    code: Code.optional(),
    interruptedFrom: StateSchema.optional(),
    resolution: z
      .object({
        decision: z.enum(['abandon', 'confirmed_complete']),
        operatorId: Identifier,
        resolvedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((record) => Boolean(record.requestKeyDigest) === Boolean(record.requestFingerprint))
  .refine((record) => record.state !== 'success' || record.pendingActions.length === 0)
  .refine(
    (record) =>
      new Set(record.pendingActions.map((action) => action.stepId)).size ===
      record.pendingActions.length,
  );
export type RunRecord = z.infer<typeof RunRecordSchema>;
export interface CreateRun {
  runId: string;
  capabilityId: string;
  artifactDigest: string;
  tenant: string;
  createdBy?: string;
  requestKeyDigest?: string;
  requestFingerprint?: string;
}
export interface RunRequest {
  capabilityId: string;
  tenant: string;
  artifactDigest: string;
  inputs: Record<string, unknown>;
}
const SnapshotSchema = z.object({ version: z.literal(1), runs: z.array(RunRecordSchema) }).strict();
const terminal = new Set<DurableRunState>([
  'success',
  'business_outcome',
  'failed',
  'interrupted',
  'closed',
]);

function fail(code: string): never {
  throw new Error(code);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return fail('RUN_LOCK_UNAVAILABLE');
  }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RUN_STORE_UNSAFE_PATH');
}

function assertFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('RUN_STORE_UNSAFE_PATH');
}

/** A rename is visible only after its bytes and parent directory have been synced. */
function atomicWrite(directory: string, name: string, data: string | Buffer): void {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, join(directory, name));
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

/** Stable JSON for keyed fingerprints. Raw arguments never leave this function. */
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || seen.has(value))
    return fail('INVALID_RUN_INPUTS');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(',')}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail('INVALID_RUN_INPUTS');
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * One local worker owns the directory for its lifetime. Every contender publishes
 * its own exclusive claim before checking for a live owner. Competing claims may
 * both refuse, but cannot both succeed. Dead claims are removed only after this
 * process has an uncontested claim; a live worker's claim is never stolen.
 *
 * Run state contains no browser state or arguments. A process restart interrupts
 * unfinished work and requires reconciliation, never automatic write replay.
 */
export class RunStore {
  readonly directory: string;
  private readonly claimName = `${process.pid}-${randomUUID()}`;
  private readonly workers: string;
  private readonly claim: string;
  private secret!: Buffer;
  private records: RunRecord[] = [];
  private disposed = false;
  private faulted = false;

  constructor(directory = process.env.RUN_STATE_DIR ?? '.runs/runtime') {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    assertDirectory(this.directory);
    this.workers = join(this.directory, '.workers');
    mkdirSync(this.workers, { recursive: true, mode: 0o700 });
    assertDirectory(this.workers);
    this.claim = join(this.workers, this.claimName);
    mkdirSync(this.claim, { mode: 0o700 });
    try {
      syncDirectory(this.workers);
      const stale: string[] = [];
      for (const name of readdirSync(this.workers)) {
        if (name === this.claimName) continue;
        const match = /^(\d+)-[a-f0-9-]{36}$/.exec(name);
        if (!match) fail('RUN_LOCK_CORRUPT');
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid < 1) fail('RUN_LOCK_CORRUPT');
        assertDirectory(join(this.workers, name));
        if (processAlive(pid)) fail('RUN_WORKER_ACTIVE');
        stale.push(name);
      }
      for (const name of stale) rmSync(join(this.workers, name), { recursive: true });
      syncDirectory(this.workers);
      const snapshotPath = join(this.directory, 'runs.json');
      const secretPath = join(this.directory, 'fingerprint.key');
      if (!existsSync(secretPath)) {
        if (existsSync(snapshotPath)) fail('RUN_STORE_SECRET_MISSING');
        atomicWrite(this.directory, 'fingerprint.key', randomBytes(32));
      }
      assertFile(secretPath);
      this.secret = readFileSync(secretPath);
      if (this.secret.length !== 32) fail('RUN_STORE_SECRET_CORRUPT');
      if (existsSync(snapshotPath)) {
        assertFile(snapshotPath);
        let data: unknown;
        try {
          data = JSON.parse(readFileSync(snapshotPath, 'utf8'));
        } catch {
          fail('RUN_STORE_CORRUPT');
        }
        const parsed = SnapshotSchema.safeParse(data);
        if (!parsed.success) fail('RUN_STORE_CORRUPT');
        this.records = parsed.data.runs;
        const ids = new Set<string>();
        const keys = new Set<string>();
        for (const record of this.records) {
          if (ids.has(record.runId)) fail('RUN_STORE_CORRUPT');
          ids.add(record.runId);
          if (record.requestKeyDigest) {
            if (keys.has(record.requestKeyDigest)) fail('RUN_STORE_CORRUPT');
            keys.add(record.requestKeyDigest);
          }
        }
      }
      let changed = false;
      for (const record of this.records) {
        if (terminal.has(record.state)) continue;
        changed = true;
        record.interruptedFrom = record.state;
        record.state = 'interrupted';
        record.updatedAt = new Date().toISOString();
        record.code = 'WORKER_INTERRUPTED';
        if (
          record.interruptedFrom === 'human' ||
          record.pendingActions.some((action) => action.effect === 'draft')
        )
          record.effectStatus = 'unknown';
      }
      if (changed || !existsSync(snapshotPath)) this.persist(this.records);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private assertOwner(): void {
    if (this.disposed || !existsSync(this.claim)) fail('RUN_STORE_CLOSED');
    if (this.faulted) fail('RUN_STORE_UNAVAILABLE');
    assertDirectory(this.claim);
  }

  private persist(records: RunRecord[]): void {
    this.assertOwner();
    const parsed = SnapshotSchema.safeParse({ version: 1, runs: records });
    if (!parsed.success) fail('INVALID_RUN_RECORD');
    try {
      atomicWrite(this.directory, 'runs.json', `${JSON.stringify(parsed.data, null, 2)}\n`);
    } catch {
      // A failed directory sync may follow a successful rename. In that case the
      // durable snapshot is ahead of memory and only a fresh owner may inspect it.
      this.faulted = true;
      fail('RUN_STORE_WRITE_FAILED');
    }
    this.records = parsed.data.runs;
  }

  private update(runId: string, mutation: (record: RunRecord) => void): RunRecord {
    this.assertOwner();
    const records = structuredClone(this.records);
    const record = records.find((entry) => entry.runId === runId);
    if (!record) fail('RUN_NOT_FOUND');
    mutation(record);
    record.updatedAt = new Date().toISOString();
    this.persist(records);
    return structuredClone(record);
  }

  create(run: CreateRun): RunRecord {
    this.assertOwner();
    if (this.records.some((record) => record.runId === run.runId)) fail('RUN_ALREADY_EXISTS');
    if (run.requestKeyDigest && this.findByRequestKey(run.requestKeyDigest))
      fail('RUN_REQUEST_KEY_EXISTS');
    const now = new Date().toISOString();
    const parsed = RunRecordSchema.safeParse({
      ...run,
      state: 'running',
      startedAt: now,
      updatedAt: now,
      pendingActions: [],
      effectStatus: 'none',
    });
    if (!parsed.success) fail('INVALID_RUN_RECORD');
    this.persist([...this.records, parsed.data]);
    return structuredClone(parsed.data);
  }

  beginStep(runId: string, stepId: string, effect: DurableEffect): RunRecord {
    return this.update(runId, (record) => {
      if (
        record.state !== 'running' &&
        !(record.state === 'human' && stepId === 'human_control' && effect === 'draft')
      )
        fail('RUN_NOT_RUNNING');
      if (record.pendingActions.some((action) => action.stepId === stepId))
        fail('RUN_ACTION_ALREADY_PENDING');
      record.stepId = stepId;
      record.pendingActions.push({ stepId, effect, startedAt: new Date().toISOString() });
      if (effect === 'draft') record.effectStatus = 'possible';
    });
  }

  completeStep(runId: string, stepId: string): RunRecord {
    return this.update(runId, (record) => {
      if (terminal.has(record.state)) fail('RUN_TERMINAL');
      const action = record.pendingActions.find((pending) => pending.stepId === stepId);
      if (!action) fail('RUN_ACTION_NOT_PENDING');
      record.pendingActions = record.pendingActions.filter((pending) => pending.stepId !== stepId);
      if (action.effect === 'draft') record.effectStatus = 'confirmed';
      if (record.pendingActions.some((pending) => pending.effect === 'draft'))
        record.effectStatus = 'possible';
      record.stepId = stepId;
    });
  }

  transition(runId: string, state: DurableRunState, code?: string): RunRecord {
    return this.update(runId, (record) => {
      if (terminal.has(record.state)) {
        if (record.state === state && record.code === code) return;
        fail('RUN_TERMINAL');
      }
      if (state === 'success' && record.pendingActions.length > 0) fail('RUN_ACTION_PENDING');
      record.state = state;
      record.code = code;
      if (terminal.has(state) && record.pendingActions.some((action) => action.effect === 'draft'))
        record.effectStatus = 'unknown';
    });
  }

  get(runId: string): RunRecord | undefined {
    this.assertOwner();
    const record = this.records.find((entry) => entry.runId === runId);
    return record ? structuredClone(record) : undefined;
  }

  getRecord(runId: string): RunRecord {
    const record = this.get(runId);
    if (!record) fail('RUN_NOT_FOUND');
    return record;
  }

  list(): RunRecord[] {
    this.assertOwner();
    return structuredClone(this.records);
  }

  listRecords(): RunRecord[] {
    return this.list();
  }

  keyFingerprint(requestKey: string): string {
    this.assertOwner();
    if (typeof requestKey !== 'string' || requestKey.length < 1 || requestKey.length > 256)
      fail('INVALID_REQUEST_KEY');
    return createHmac('sha256', this.secret).update(`request-key\0${requestKey}`).digest('hex');
  }

  requestFingerprint(request: RunRequest): string {
    this.assertOwner();
    if (
      !Identifier.safeParse(request.capabilityId).success ||
      !Identifier.safeParse(request.tenant).success ||
      !Digest.safeParse(request.artifactDigest).success
    )
      fail('INVALID_RUN_REQUEST');
    return createHmac('sha256', this.secret)
      .update(`request-body\0${canonical(request)}`)
      .digest('hex');
  }

  findByRequestKey(requestKeyDigest: string): RunRecord | undefined {
    this.assertOwner();
    if (!Digest.safeParse(requestKeyDigest).success) fail('INVALID_REQUEST_KEY');
    const record = this.records.find((entry) => entry.requestKeyDigest === requestKeyDigest);
    return record ? structuredClone(record) : undefined;
  }

  resolveInterrupted(runId: string, decision: ResolutionDecision, operatorId: string): RunRecord {
    return this.update(runId, (record) => {
      if (record.state !== 'interrupted') fail('RUN_NOT_INTERRUPTED');
      record.resolution = { decision, operatorId, resolvedAt: new Date().toISOString() };
      record.state = 'closed';
      record.code = 'OPERATOR_RECONCILED';
      // Abandoning a run says nothing about whether its effect happened.
      if (decision === 'confirmed_complete') record.effectStatus = 'confirmed';
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    rmSync(this.claim, { recursive: true, force: true });
    syncDirectory(this.workers);
    this.secret?.fill(0);
  }
}
