import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { startSimulator, DEMO_INPUTS } from '../sim/server.js';
import { launchSurface, WebSurface } from '../src/surface/web.js';
import { ReplayEngine, classifyObservation } from '../src/replay/engine.js';
import { createFixtureCapability } from './fixture.js';
import { sealCapability } from '../src/compiler/compile.js';
import type { Observation, Target } from '../src/schema/index.js';

let sim: Awaited<ReturnType<typeof startSimulator>>;
beforeAll(async () => {
  sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
});
afterAll(async () => {
  await sim.close();
});
const member: Target = {
  frame: [],
  anchors: [{ by: 'label', text: '@memberId' }],
  minAgree: 1,
  required: [0],
};

describe('adversarial live browser states', () => {
  it.each(['insert', 'replace', 'relabel'] as const)(
    'does not fill another field after a same-tag DOM %s',
    async (mutation) => {
      const live = await launchSurface({ profile: sim.profiles.a, headless: true });
      try {
        await live.page.goto(`${sim.profiles.a.origin}/core/members/search`);
        await live.page.setContent('<input aria-label="Member #" id="member">');
        const seam = live.surface as unknown as {
          resolveRecord: (...args: unknown[]) => Promise<unknown>;
        };
        const original = seam.resolveRecord.bind(live.surface);
        const spy = vi.spyOn(seam, 'resolveRecord').mockImplementationOnce(async (...args) => {
          const record = await original(...args);
          await live.page.evaluate((mode) => {
            const old = document.querySelector('input')!;
            const other = document.createElement('input');
            other.setAttribute('aria-label', 'Tax ID');
            other.id = 'other';
            if (mode === 'insert') old.before(other);
            else if (mode === 'replace') old.replaceWith(other);
            else old.setAttribute('aria-label', 'Tax ID');
          }, mutation);
          return record;
        });
        try {
          const action = live.surface.act(
            { type: 'fill', target: 'member', value: { input: 'memberId' } },
            { member },
            { ...DEMO_INPUTS },
          );
          if (mutation === 'insert') {
            await action;
            expect(await live.page.locator('#member').inputValue()).toBe(DEMO_INPUTS.memberId);
          } else await expect(action).rejects.toThrow();
          expect(await live.page.getByLabel('Tax ID').inputValue()).toBe('');
        } finally {
          spy.mockRestore();
        }
      } finally {
        await live.close();
      }
    },
  );

  it('prioritizes an unknown modal over a recoverable notice', () => {
    const observation: Observation = {
      id: 'test',
      url: sim.profiles.a.origin,
      texts: [],
      elements: [
        {
          ref: 'a',
          frame: [],
          role: 'heading',
          tag: 'h1',
          text: 'System Notice',
          name: 'System Notice',
          anchors: [],
        },
        {
          ref: 'b',
          frame: [],
          role: 'alertdialog',
          tag: 'div',
          text: 'Unexpected authorization',
          name: 'Unexpected authorization',
          anchors: [],
        },
      ],
    };
    expect(classifyObservation(observation, sim.profiles.a)).toMatchObject({
      kind: 'escalated',
      code: 'UNKNOWN_DIALOG',
    });
  });

  it('observes an unknown modal even when it contains editable fields and buttons', async () => {
    const live = await launchSurface({ profile: sim.profiles.a, headless: true });
    try {
      await live.page.setContent(
        '<h1>System Notice</h1><div role="dialog" aria-label="Unexpected"><input aria-label="Member #"><button>Continue</button></div>',
      );
      expect(classifyObservation(await live.surface.observe(), sim.profiles.a)).toMatchObject({
        kind: 'escalated',
        code: 'UNKNOWN_DIALOG',
      });
    } finally {
      await live.close();
    }
  });

  it('never resubmits an accepted draft when its response cannot be verified', async () => {
    const { digest: _, ...base } = createFixtureCapability();
    base.steps.at(-1)!.timeoutMs = 150;
    const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
    const live = await launchSurface({
      profile: sim.profiles.a,
      cookies: [ticket.cookie],
      headless: true,
    });
    const engine = new ReplayEngine(sealCapability(base), { ...DEMO_INPUTS }, sim.profiles.a, {
      page: live.page,
      session: live.session,
    });
    try {
      await live.page.route('**/core/application/review', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: '<h1>Processing</h1>' });
      });
      expect(await engine.run()).toMatchObject({
        status: 'escalated',
        reason: 'UNKNOWN_ACTION_OUTCOME',
      });
      expect(await engine.resume()).toMatchObject({ status: 'escalated', reason: 'UNSAFE_RESUME' });
      const state = sim.inspectSession(ticket.sessionId);
      expect(state.events.filter((e) => e.kind === 'draft_prepared')).toHaveLength(1);
      expect(state.forbiddenCommitCount).toBe(0);
    } finally {
      await engine.close();
      await live.close();
    }
  });

  it('aborts an in-flight run without giving queued actions back to automation', async () => {
    const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS, fault: 'slow_load' });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      const running = engine.run();
      await vi.waitFor(() => expect(engine.surface?.metrics.actionCount).toBeGreaterThanOrEqual(3));
      const aborted = await engine.abort();
      expect(aborted).toMatchObject({ status: 'failed', code: 'OPERATOR_ABORTED' });
      expect(await running).toMatchObject({ status: 'failed', code: 'OPERATOR_ABORTED' });
      expect(engine.session.owner).toBe('none');
      await expect(engine.resume()).rejects.toThrow('RESUME_NOT_AVAILABLE');
      expect(sim.inspectSession(ticket.sessionId).draft).toBeNull();
    } finally {
      await engine.close();
    }
  });

  it.each(['permission', 'amount'])(
    'rejects a late %s change during final output collection',
    async (change) => {
      const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
      const engine = new ReplayEngine(
        createFixtureCapability(),
        { ...DEMO_INPUTS },
        sim.profiles.a,
        { cookies: [ticket.cookie] },
      );
      const original = WebSurface.prototype.read;
      let reads = 0;
      const spy = vi.spyOn(WebSurface.prototype, 'read').mockImplementation(async function (
        this: WebSurface,
        ...args
      ) {
        const result = await original.apply(this, args);
        if (++reads === 4) {
          const frame = this.page
            .frames()
            .find((f) => f.name() === sim.profiles.a.frameAliases.content)!;
          await frame.evaluate((change) => {
            if (change === 'amount') {
              const row = Array.from(document.querySelectorAll('tr')).find(
                (row) => row.children[0]?.textContent?.trim() === 'Opening deposit',
              )!;
              row.children[1]!.textContent = '$0.01';
              return;
            }
            const heading = document.createElement('h1');
            heading.textContent = 'Permission denied';
            document.body.append(heading);
          }, change);
        }
        return result;
      });
      try {
        const result = await engine.run();
        expect(result.status).not.toBe('success');
        expect(sim.inspectSession(ticket.sessionId).forbiddenCommitCount).toBe(0);
      } finally {
        spy.mockRestore();
        await engine.close();
      }
    },
  );
});
