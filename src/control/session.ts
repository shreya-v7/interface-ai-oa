import { randomUUID } from 'node:crypto';
import { writeEvent } from '../policy/events.js';

export type SessionState =
  'running' | 'pausing' | 'awaiting_human' | 'human' | 'resyncing' | 'failed' | 'aborted';
export class ControlError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ControlError';
  }
}
export class SessionController {
  readonly id: string;
  epoch = 0;
  state: SessionState = 'running';
  owner: 'automation' | 'human' | 'none' = 'automation';
  reason?: string;
  humanActor: 'human' | 'test_operator' = 'human';
  private active = new Set<Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly runId: string = randomUUID(),
    readonly journalPath?: string,
  ) {
    this.id = runId;
  }
  assertOwner(epoch = this.epoch): void {
    if (this.owner !== 'automation' || this.state !== 'running')
      throw new ControlError('CONTROL_NOT_AUTOMATION');
    if (epoch !== this.epoch) throw new ControlError('STALE_CONTROL_EPOCH');
  }
  async dispatch<T>(epoch: number, action: () => Promise<T>): Promise<T> {
    this.assertOwner(epoch);
    const execution = this.tail.then(async () => {
      this.assertOwner(epoch);
      return action();
    });
    this.tail = execution.catch(() => {});
    this.active.add(execution);
    try {
      return await execution;
    } finally {
      this.active.delete(execution);
    }
  }
  async pause(reason: string): Promise<void> {
    if (this.state === 'aborted' || this.state === 'failed')
      throw new ControlError('SESSION_TERMINAL');
    if (this.state === 'human' || this.state === 'awaiting_human') {
      this.reason = reason;
      return;
    }
    this.reason = reason;
    this.state = 'pausing';
    this.owner = 'none';
    this.epoch++;
    await Promise.allSettled([...this.active]);
    if ((this.state as SessionState) === 'aborted') return;
    this.state = 'awaiting_human';
    await writeEvent(this.journalPath, {
      runId: this.runId,
      type: 'control',
      state: this.state,
      epoch: this.epoch,
      code: reason,
    });
  }
  async takeover(actor: 'human' | 'test_operator' = 'human'): Promise<void> {
    if (this.state === 'running') await this.pause('OPERATOR_TAKEOVER');
    if (this.state !== 'awaiting_human' && this.state !== 'human')
      throw new ControlError('TAKEOVER_NOT_AVAILABLE');
    this.owner = 'human';
    this.humanActor = actor;
    this.state = 'human';
    this.epoch++;
    await writeEvent(this.journalPath, {
      runId: this.runId,
      type: 'control',
      state: this.state,
      actor,
      epoch: this.epoch,
    });
  }
  async resume(): Promise<void> {
    if (this.state !== 'human' && this.state !== 'awaiting_human' && this.state !== 'resyncing')
      throw new ControlError('RESUME_NOT_AVAILABLE');
    this.epoch++;
    this.owner = 'automation';
    this.state = 'running';
    this.reason = undefined;
    await writeEvent(this.journalPath, {
      runId: this.runId,
      type: 'control',
      state: this.state,
      actor: 'automation',
      epoch: this.epoch,
    });
  }
  async abort(): Promise<void> {
    this.epoch++;
    this.owner = 'none';
    this.state = 'aborted';
    await Promise.allSettled([...this.active]);
    await writeEvent(this.journalPath, {
      runId: this.runId,
      type: 'control',
      state: 'aborted',
      epoch: this.epoch,
    });
  }
}
