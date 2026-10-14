import { afterAll, beforeAll, expect, it } from 'vitest';
import { startSimulator, DEMO_INPUTS, SHADOW_INPUTS } from '../sim/server.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { inspectDisplayedReview, reviewEquals } from '../eval/oracle.js';
import { createFixtureCapability } from './fixture.js';

let sim: Awaited<ReturnType<typeof startSimulator>>;
beforeAll(async () => {
  sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
});
afterAll(async () => {
  await sim?.close();
});

it.each(['a', 'b'] as const)(
  'isolates tenant a from a second tenant %s run, including browser storage and outputs',
  async (secondTenant) => {
    const firstTicket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
    const secondTicket = sim.createSession({ tenant: secondTenant, inputs: SHADOW_INPUTS });
    const first = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [firstTicket.cookie],
    });
    const second = new ReplayEngine(
      createFixtureCapability(),
      { ...SHADOW_INPUTS },
      sim.profiles[secondTenant],
      { cookies: [secondTicket.cookie] },
    );
    try {
      expect(await first.run()).toMatchObject({ status: 'success', outputs: DEMO_INPUTS });
      await first.surface.page.evaluate(() => localStorage.setItem('isolation_probe', 'first'));
      await first.surface.page
        .context()
        .addCookies([{ name: 'isolation_probe', value: 'first', url: sim.profiles.a.origin }]);

      expect(await second.run()).toMatchObject({ status: 'success', outputs: SHADOW_INPUTS });
      expect(second.surface.page.context()).not.toBe(first.surface.page.context());
      expect(
        await second.surface.page.evaluate(() => localStorage.getItem('isolation_probe')),
      ).toBeNull();
      const secondCookies = await second.surface.page.context().cookies();
      expect(secondCookies.some((cookie) => cookie.name === 'isolation_probe')).toBe(false);
      expect(secondCookies.filter((cookie) => cookie.name.startsWith('legacy_session_'))).toEqual([
        expect.objectContaining({ name: secondTicket.cookie.name, value: secondTicket.sessionId }),
      ]);
      await second.surface.page.evaluate(() => localStorage.setItem('isolation_probe', 'second'));
      expect(await first.surface.page.evaluate(() => localStorage.getItem('isolation_probe'))).toBe(
        'first',
      );

      expect(sim.inspectSession(firstTicket.sessionId).draft).toEqual(DEMO_INPUTS);
      expect(sim.inspectSession(secondTicket.sessionId).draft).toEqual(SHADOW_INPUTS);
      expect(
        reviewEquals(
          { ...SHADOW_INPUTS },
          await inspectDisplayedReview(
            second.surface.page,
            sim.profiles[secondTenant].labelAliases as never,
          ),
        ),
      ).toBe(true);

      await first.close();
      expect(second.surface.page.isClosed()).toBe(false);
      expect(
        await second.surface.page.evaluate(() => localStorage.getItem('isolation_probe')),
      ).toBe('second');
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  },
);
