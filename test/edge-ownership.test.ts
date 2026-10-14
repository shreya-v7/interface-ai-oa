import { describe, expect, it } from 'vitest';
import { SessionController } from '../src/control/session.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe('adversarial ownership races', () => {
  it('cancels queued actions and waits for the dispatched action when abort races takeover', async () => {
    const controller = new SessionController('race');
    const entered = latch(),
      blocked = latch();
    let queuedRan = false;
    const first = controller.dispatch(controller.epoch, async () => {
      entered.release();
      await blocked.promise;
    });
    await entered.promise;
    const second = controller.dispatch(controller.epoch, async () => {
      queuedRan = true;
    });
    const secondRejected = expect(second).rejects.toThrow('CONTROL_NOT_AUTOMATION');
    const pause = controller.pause('TEST');
    const abort = controller.abort();
    blocked.release();
    await Promise.all([first, secondRejected, pause, abort]);
    expect(queuedRan).toBe(false);
    expect(controller.state).toBe('aborted');
    expect(controller.owner).toBe('none');
    await expect(controller.takeover()).rejects.toThrow();
    await expect(controller.resume()).rejects.toThrow();
  });

  it('never grants automation after a stale pause finishes behind human takeover', async () => {
    const controller = new SessionController('double-pause');
    const entered = latch(),
      blocked = latch();
    const active = controller.dispatch(controller.epoch, async () => {
      entered.release();
      await blocked.promise;
    });
    await entered.promise;
    const pauses = [controller.pause('FIRST'), controller.pause('SECOND')];
    blocked.release();
    await Promise.all([active, ...pauses]);
    await controller.takeover('test_operator');
    const epoch = controller.epoch;
    await expect(controller.dispatch(epoch, async () => {})).rejects.toThrow(
      'CONTROL_NOT_AUTOMATION',
    );
    await controller.resume();
    await expect(controller.dispatch(epoch, async () => {})).rejects.toThrow('STALE_CONTROL_EPOCH');
  });
});
