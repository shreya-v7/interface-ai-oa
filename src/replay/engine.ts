import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  CapabilitySchema,
  validateInputs,
  type Capability,
  type Inputs,
  type Profile,
  type RunResult,
  type Step,
  type Observation,
  type Target,
} from '../schema/index.js';
import { validateReferences } from '../compiler/compile.js';
import { SessionController } from '../control/session.js';
import {
  WebSurface,
  launchSurface,
  alias,
  SurfaceError,
  type LaunchOptions,
} from '../surface/web.js';
import { structuralObservation, writeEvent } from '../policy/events.js';
import { parseMoney } from '../schema/money.js';

export interface EngineOptions extends Omit<LaunchOptions, 'profile'> {
  page?: Page;
  session?: SessionController;
  evidenceDir?: string;
}
export interface RunDurability {
  begin(stepId: string, effect: 'read' | 'draft'): void;
  checkpoint(stepId: string): void;
  settle(result: RunResult): void;
}
const HandlerSchema = z
  .object({
    action: z.enum(['click', 'retry_read']),
    role: z.enum(['button', 'link']),
    label: z.string(),
    maxAttempts: z.number().int().min(1).max(2),
  })
  .strict();
type Handler = z.infer<typeof HandlerSchema>;
const exceptionPack = z
  .object({
    id: z.string(),
    rules: z.array(
      z
        .object({
          code: z.string().regex(/^[A-Z_]+$/),
          marker: z.string(),
          disposition: z.enum(['failed', 'escalated', 'business_outcome', 'recoverable']),
          handler: HandlerSchema.optional(),
        })
        .strict()
        .refine((r) => (r.disposition === 'recoverable') === !!r.handler, 'Handler mismatch'),
    ),
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(new URL('../../vendor/legacy-core/exceptions.json', import.meta.url), 'utf8'),
    ),
  );
export type Classification = {
  code: string;
  kind: 'business_outcome' | 'failed' | 'escalated' | 'recoverable';
  handler?: Handler;
};
const PRECEDENCE = ['failed', 'escalated', 'business_outcome', 'recoverable'] as const;
/**
 * Classifies a screen against the reviewed vendor exception pack. Markers are vendor
 * label keys resolved through the tenant profile, so tenants may word them differently.
 * Blocking states take precedence over business outcomes, which take precedence over
 * recoverable notices; two business outcomes at once escalate as a conflict.
 */
export function classifyObservation(
  observation: Observation,
  profile: Profile,
): Classification | undefined {
  const shown = (marker: string) => {
    const label = alias(marker, profile);
    return observation.elements.some(
      (e) => e.text === label && (e.role === 'heading' || e.tag === 'h1' || e.tag === 'h2'),
    );
  };
  const unknownDialog = observation.elements.some(
    (e) =>
      (e.role === 'dialog' || e.role === 'alertdialog') &&
      !exceptionPack.rules.some(
        (rule) =>
          rule.handler?.action === 'click' &&
          e.role === 'dialog' &&
          e.name === alias(rule.marker, profile) &&
          shown(rule.marker),
      ),
  );
  for (const disposition of PRECEDENCE) {
    if (disposition !== 'failed' && unknownDialog)
      return { kind: 'escalated', code: 'UNKNOWN_DIALOG' };
    const hits = exceptionPack.rules.filter(
      (r) => r.disposition === disposition && shown(r.marker),
    );
    if (disposition === 'business_outcome' && hits.length > 1)
      return { kind: 'escalated', code: 'CONFLICTING_STATES' };
    if (hits[0]) return { kind: disposition, code: hits[0].code, handler: hits[0].handler };
  }
  return undefined;
}
const waitTick = () => new Promise<void>((resolve) => setTimeout(resolve, 75));
export class ReplayEngine {
  readonly capability: Capability;
  readonly inputs: Inputs;
  readonly runId: string;
  surface!: WebSurface;
  session: SessionController;
  result?: RunResult;
  stepIndex = 0;
  assisted = false;
  recoveries: string[] = [];
  private launched?: Awaited<ReturnType<typeof launchSurface>>;
  private dispatched = false;
  private initialized = false;
  private executing = false;
  private executionSettled: Promise<void> = Promise.resolve();
  private recoveryCount = 0;
  private activeStarted = 0;
  private activeMs = 0;
  private closed = false;
  private acknowledgedDialogs = 0;
  private durability?: RunDurability;
  constructor(
    capability: Capability,
    inputs: Inputs,
    readonly profile: Profile,
    readonly options: EngineOptions = {},
  ) {
    this.capability = CapabilitySchema.parse(capability);
    validateReferences(this.capability);
    if (this.capability.exceptions !== exceptionPack.id) throw new Error('UNKNOWN_EXCEPTION_PACK');
    this.inputs = validateInputs(capability.inputs, inputs);
    if (
      capability.app.vendor !== profile.vendor ||
      !capability.app.versions.includes(profile.appVersion)
    )
      throw new Error('UNSUPPORTED_APP_VERSION');
    this.runId = options.runId ?? randomUUID();
    this.session = options.session ?? new SessionController(this.runId, options.journalPath);
  }
  attachDurability(durability: RunDurability): void {
    if (this.initialized || this.durability) throw new Error('DURABILITY_ALREADY_BOUND');
    this.durability = durability;
  }
  /** Headers of every table-row identity anchor this capability relies on. */
  private rowKeyLabels(): string[] {
    return [
      ...new Set(
        Object.values(this.capability.targets).flatMap((t) =>
          t.anchors.flatMap((a) => (a.by === 'tableRow' ? [a.header] : [])),
        ),
      ),
    ];
  }
  private classify(observation: Observation) {
    return classifyObservation(observation, this.profile);
  }
  private async initialize() {
    if (this.initialized) return;
    if (this.options.page)
      this.surface = new WebSurface(this.options.page, this.profile, {
        session: this.session,
        journalPath: this.options.journalPath,
        rowKeyLabels: this.rowKeyLabels(),
      });
    else {
      try {
        this.launched = await launchSurface({
          ...this.options,
          profile: this.profile,
          runId: this.runId,
          rowKeyLabels: this.rowKeyLabels(),
          startURL: undefined,
        });
      } catch {
        // Nothing was dispatched; report the infrastructure fault distinctly.
        throw new SurfaceError('BROWSER_LAUNCH_FAILED');
      }
      this.surface = this.launched.surface;
      this.session = this.launched.session;
    }
    await this.surface.ready;
    this.initialized = true;
    await writeEvent(this.options.journalPath, {
      runId: this.runId,
      type: 'run_start',
      state: 'running',
    });
  }
  private step(): Step | undefined {
    return this.capability.steps[this.stepIndex];
  }
  private async observe(): Promise<Observation> {
    if (this.surface.page.isClosed()) throw new Error('SESSION_LOST');
    if ((this.surface.network?.nativeDialogs ?? 0) > this.acknowledgedDialogs)
      throw new SurfaceError('UNKNOWN_NATIVE_DIALOG');
    return this.surface.observe();
  }
  /** Enforces the capability's declared identity binding; capabilities without one skip it. */
  private identityMatches(observation: Observation): boolean {
    const identity = this.capability.identity;
    if (!identity) return true;
    const screens = identity.screens.map((s) => alias(s, this.profile));
    const inSubjectScreen = observation.elements.some(
      (e) => e.role === 'heading' && screens.includes(e.text),
    );
    if (!inSubjectScreen) return true;
    const label = alias(identity.label, this.profile);
    const values = observation.elements.filter(
      (e) =>
        e.near === label && !['textbox', 'spinbutton', 'combobox', 'columnheader'].includes(e.role),
    );
    return values.length > 0 && values.every((e) => e.text === String(this.inputs[identity.input]));
  }
  private async failure(
    code: string,
    effect: 'none' | 'applied' | 'unknown' = 'none',
  ): Promise<RunResult> {
    const evidence: string[] = [];
    if (this.options.evidenceDir && this.initialized) {
      try {
        await mkdir(this.options.evidenceDir, { recursive: true });
        const path = join(this.options.evidenceDir, 'failure-structure.json');
        await writeFile(
          path,
          JSON.stringify(structuralObservation(await this.surface.observe()), null, 2),
        );
        evidence.push(path);
        const screenshot = join(this.options.evidenceDir, 'failure.png');
        await this.surface.screenshot(screenshot);
        evidence.push(screenshot);
      } catch {
        /* Session loss can make visual evidence unavailable. */
      }
    }
    this.session.state = 'failed';
    this.session.owner = 'none';
    this.session.epoch++;
    const result: RunResult = {
      status: 'failed',
      code,
      stepId: this.step()?.id,
      expected: 'Declared checkpoint and requested identity',
      observed: 'Checkpoint not verified; see sanitized evidence',
      effect,
      evidence,
      runId: this.runId,
      assisted: this.assisted,
    };
    await writeEvent(this.options.journalPath, {
      runId: this.runId,
      type: 'run_end',
      state: result.status,
      code,
      effect,
      assisted: this.assisted,
    });
    return (this.result = result);
  }
  private async escalate(code: string): Promise<RunResult> {
    await this.session.pause(code);
    const interventionId = `intervention-${this.runId}`;
    if (this.options.evidenceDir) {
      await mkdir(this.options.evidenceDir, { recursive: true });
      try {
        await writeFile(
          join(this.options.evidenceDir, 'intervention.json'),
          JSON.stringify(
            {
              runId: this.runId,
              interventionId,
              stepId: this.step()?.id,
              reason: code,
              expected: 'Current step checkpoint and matching subject',
              observation: structuralObservation(await this.surface.observe()),
            },
            null,
            2,
          ),
        );
        await this.surface.screenshot(join(this.options.evidenceDir, 'intervention.png'));
      } catch {}
    }
    return (this.result = {
      status: 'escalated',
      interventionId,
      reason: code,
      runId: this.runId,
      assisted: this.assisted,
    });
  }
  private async handleState(state: Classification, step: Step): Promise<RunResult | undefined> {
    if (state.kind === 'failed')
      return this.failure(state.code, this.dispatched ? 'unknown' : 'none');
    if (state.kind === 'escalated') return this.escalate(state.code);
    if (state.kind === 'business_outcome') {
      const result: RunResult = {
        status: 'business_outcome',
        code: state.code,
        runId: this.runId,
        assisted: this.assisted,
      };
      await writeEvent(this.options.journalPath, {
        runId: this.runId,
        type: 'run_end',
        state: result.status,
        code: state.code,
      });
      return (this.result = result);
    }
    if (this.recoveryCount >= 2) return this.escalate('RECOVERY_EXHAUSTED');
    const handler = state.handler!;
    if (this.recoveries.filter((code) => code === state.code).length >= handler.maxAttempts)
      return this.escalate('RECOVERY_EXHAUSTED');
    // Re-requesting a page is only safe when the interrupted step was a read.
    if (handler.action === 'retry_read' && (step.effect !== 'read' || step.repeat !== 'read'))
      return this.escalate('UNSAFE_RECOVERY');
    const name = alias(handler.label, this.profile);
    const observation = await this.observe();
    const element = observation.elements.find((e) => e.role === handler.role && e.name === name);
    if (!element) return this.escalate('UNRECOGNIZED_RECOVERY_STATE');
    this.recoveryCount++;
    this.durability?.begin(`${step.id}_recovery_${this.recoveryCount}`, 'read');
    await this.surface.act(
      { type: 'click', target: 'recovery.handler' },
      {
        'recovery.handler': {
          frame: element.frame,
          anchors: [{ by: 'role', role: handler.role, name: handler.label }],
          minAgree: 1,
          required: [0],
        },
      },
      this.inputs,
    );
    this.recoveries.push(state.code);
    await writeEvent(this.options.journalPath, {
      runId: this.runId,
      stepId: step.id,
      type: 'recovery',
      code: state.code,
      count: this.recoveryCount,
    });
    return undefined;
  }
  private async awaitPost(step: Step): Promise<RunResult | undefined> {
    const deadline = Date.now() + step.timeoutMs;
    while (Date.now() < deadline) {
      this.session.assertOwner();
      const observation = await this.observe();
      if (!this.identityMatches(observation)) return this.failure('COMPLETION_MISMATCH', 'applied');
      const state = this.classify(observation);
      if (state) {
        const result = await this.handleState(state, step);
        if (result) return result;
        continue;
      }
      if (await this.surface.check(step.post, this.capability.targets, this.inputs)) {
        // Reobserve before accepting progress so a concurrently rendered blocker wins.
        const confirm = await this.observe();
        if (this.classify(confirm)) continue;
        if (!this.identityMatches(confirm)) return this.failure('COMPLETION_MISMATCH', 'applied');
        this.session.assertOwner();
        this.durability?.checkpoint(step.id);
        await writeEvent(this.options.journalPath, {
          runId: this.runId,
          stepId: step.id,
          type: 'checkpoint',
          state: 'verified',
        });
        return;
      }
      await waitTick();
    }
    return this.escalate(
      this.dispatched && step.repeat === 'never' ? 'UNKNOWN_ACTION_OUTCOME' : 'CHECKPOINT_TIMEOUT',
    );
  }
  async run(): Promise<RunResult> {
    if (this.executing) throw new Error('RUN_ALREADY_EXECUTING');
    if (this.result && this.result.status !== 'escalated') return this.result;
    this.executing = true;
    let settleExecution!: () => void;
    this.executionSettled = new Promise<void>((resolve) => {
      settleExecution = resolve;
    });
    this.activeStarted = Date.now();
    try {
      await this.initialize();
      this.session.assertOwner();
      for (; this.stepIndex < this.capability.steps.length; this.stepIndex++) {
        this.session.assertOwner();
        if (this.activeMs + Date.now() - this.activeStarted > 300_000)
          return await this.failure('RUN_TIMEOUT', this.dispatched ? 'unknown' : 'none');
        const step = this.step()!;
        this.dispatched = false;
        const before = await this.observe();
        const state = this.classify(before);
        if (state) {
          const outcome = await this.handleState(state, step);
          if (outcome) return outcome;
        }
        if (!this.identityMatches(before)) return await this.failure('COMPLETION_MISMATCH');
        if (step.pre && !(await this.surface.check(step.pre, this.capability.targets, this.inputs)))
          return await this.escalate('PRECONDITION_MISMATCH');
        await writeEvent(this.options.journalPath, {
          runId: this.runId,
          stepId: step.id,
          type: 'dispatch_intent',
          action: step.action.type,
          epoch: this.session.epoch,
        });
        const beforeActions = this.surface.metrics.actionCount;
        // A failed durable write prevents dispatch. A crash after this point leaves
        // an unresolved intent, even when the browser response was never received.
        this.durability?.begin(step.id, step.effect);
        try {
          await this.surface.act(step.action, this.capability.targets, this.inputs);
        } finally {
          this.dispatched = this.surface.metrics.actionCount > beforeActions;
        }
        const outcome = await this.awaitPost(step);
        if (outcome) return outcome;
        this.dispatched = false;
      }
      const observation = await this.observe();
      if (this.classify(observation)) return await this.failure('COMPLETION_BLOCKED');
      const outputs: Inputs = {};
      const rawOutputs: Record<string, string> = {};
      for (const [key, field] of Object.entries(this.capability.outputs)) {
        const raw = await this.surface.read(this.capability.targets[field.from]!, this.inputs);
        rawOutputs[key] = raw;
        outputs[key] = field.parser === 'usd_to_minor' ? parseMoney(raw) : raw;
      }
      const complete = await this.surface.check(
        this.capability.completion,
        this.capability.targets,
        this.inputs,
        outputs,
      );
      // Every output must have its declared type, and any output that echoes an input
      // (same name) must equal it. Outputs with no input counterpart are read-only data.
      const typed = Object.entries(this.capability.outputs).every(([key, field]) =>
        field.type === 'integer'
          ? Number.isSafeInteger(outputs[key])
          : typeof outputs[key] === 'string',
      );
      const echoed = Object.keys(outputs)
        .filter((key) => key in this.inputs)
        .every((key) => outputs[key] === this.inputs[key]);
      // Output reads cross asynchronous browser boundaries. Reject a screen that
      // changed during collection, even if the cached values match the request.
      for (const [key, field] of Object.entries(this.capability.outputs)) {
        if (
          !(await this.surface.check(
            { op: 'textEquals', target: field.from, value: { const: rawOutputs[key]! } },
            this.capability.targets,
            this.inputs,
          ))
        )
          return await this.failure('COMPLETION_MISMATCH', 'applied');
      }
      const finalObservation = await this.observe();
      if (this.classify(finalObservation))
        return await this.failure('COMPLETION_BLOCKED', 'applied');
      if (!this.identityMatches(finalObservation))
        return await this.failure('COMPLETION_MISMATCH', 'applied');
      this.session.assertOwner();
      if (!complete || !typed || !echoed)
        return await this.failure('COMPLETION_MISMATCH', 'applied');
      this.result = {
        status: 'success',
        outputs,
        runId: this.runId,
        recoveries: [...this.recoveries],
        drift: [...this.surface.drift],
        assisted: this.assisted,
      };
      await writeEvent(this.options.journalPath, {
        runId: this.runId,
        type: 'run_end',
        state: 'success',
        assisted: this.assisted,
      });
      return this.result;
    } catch (error) {
      if (this.session.state === 'aborted') return (this.result = this.abortedResult());
      const code =
        (error as { code?: string }).code ??
        ((error as Error).message === 'SESSION_LOST' ? 'SESSION_LOST' : 'EXECUTION_ERROR');
      if (['CONTROL_NOT_AUTOMATION', 'STALE_CONTROL_EPOCH'].includes(code))
        return await this.escalate(this.session.reason ?? 'OPERATOR_TAKEOVER');
      if (
        [
          'AMBIGUOUS_TARGET',
          'ANCHOR_DISAGREEMENT',
          'MANDATORY_ANCHOR_MISSING',
          'ANCHOR_QUORUM_FAILED',
          'TARGET_NOT_FOUND',
          'UNKNOWN_NATIVE_DIALOG',
        ].includes(code)
      )
        return await this.escalate(code);
      return await this.failure(code, this.dispatched ? 'unknown' : 'none');
    } finally {
      this.activeMs += Date.now() - this.activeStarted;
      this.executing = false;
      try {
        if (this.result) this.durability?.settle(this.result);
      } finally {
        settleExecution();
      }
    }
  }
  async takeover(actor: 'human' | 'test_operator' = 'human'): Promise<void> {
    if (!this.initialized || (this.result && this.result.status !== 'escalated'))
      throw new Error('TAKEOVER_NOT_AVAILABLE');
    await this.session.pause('OPERATOR_TAKEOVER');
    await this.executionSettled;
    await this.session.takeover(actor);
    this.assisted = true;
  }
  async resume(): Promise<RunResult> {
    if (this.executing) throw new Error('RUN_ALREADY_EXECUTING');
    if (!this.initialized || this.closed || this.surface.page.isClosed())
      return this.failure('SESSION_LOST', 'unknown');
    if (!['human', 'awaiting_human'].includes(this.session.state))
      throw new Error('RESUME_NOT_AVAILABLE');
    const dialogs = this.surface.network?.nativeDialogs ?? 0;
    if (dialogs > this.acknowledgedDialogs) {
      if (this.session.owner !== 'human') return this.escalate('NATIVE_DIALOG_REQUIRES_HUMAN');
      this.acknowledgedDialogs = dialogs;
    }
    try {
      return await this.reconcileResume();
    } catch (error) {
      if (this.session.state === 'aborted') return (this.result = this.abortedResult());
      const code = error instanceof SurfaceError ? error.code : 'RESYNC_FAILED';
      return this.escalate(code);
    }
  }
  private async reconcileResume(): Promise<RunResult> {
    const epoch = this.session.epoch;
    this.session.state = 'resyncing';
    this.session.owner = 'none';
    const observation = await this.observe();
    if (!this.identityMatches(observation)) return this.escalate('WRONG_SUBJECT_ON_RESUME');
    const state = this.classify(observation);
    if (state) return this.escalate(`RESUME_${state.code}`);
    const step = this.step();
    if (!step) return this.failure('NO_SUSPENDED_STEP');
    if (await this.surface.check(step.post, this.capability.targets, this.inputs)) {
      this.stepIndex++;
    } else if (
      this.dispatched &&
      (step.repeat === 'never' ||
        !step.pre ||
        !(await this.surface.check(step.pre, this.capability.targets, this.inputs)))
    )
      return this.escalate('UNSAFE_RESUME');
    else if (
      step.pre &&
      !(await this.surface.check(step.pre, this.capability.targets, this.inputs))
    )
      return this.escalate('WRONG_STATE_ON_RESUME');
    if (this.session.epoch !== epoch || this.session.state !== 'resyncing')
      throw new Error('STALE_RESUME');
    // Either the postcondition was observed or the declared safe retry was proved.
    // Neither case allows a blind repeat of an uncertain, nonrepeatable write.
    this.durability?.checkpoint(step.id);
    this.assisted = true;
    this.dispatched = false;
    this.result = undefined;
    await this.session.resume();
    return this.run();
  }
  async abort(): Promise<RunResult> {
    await this.session.abort();
    await this.executionSettled;
    this.result = this.abortedResult();
    this.durability?.settle(this.result);
    return this.result;
  }
  private abortedResult(): RunResult {
    return {
      status: 'failed',
      code: 'OPERATOR_ABORTED',
      runId: this.runId,
      stepId: this.step()?.id,
      expected: 'Operator continuation',
      observed: 'Run aborted',
      effect: this.dispatched ? 'unknown' : 'none',
      evidence: [],
      assisted: this.assisted,
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.launched) await this.launched.close();
    else if (this.initialized) await this.surface.page.context().close();
  }
}
export async function replay(
  capability: Capability,
  inputs: Inputs,
  profile: Profile,
  options: EngineOptions = {},
): Promise<RunResult> {
  const engine = new ReplayEngine(capability, inputs, profile, options);
  try {
    return await engine.run();
  } finally {
    await engine.close();
  }
}
