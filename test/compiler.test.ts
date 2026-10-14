import { describe, it, expect } from 'vitest';
import { createFixtureCapability } from './fixture.js';
import {
  assertNoDiscoveryLiterals,
  canonicalRoute,
  verifyDigest,
  targetFromElement,
} from '../src/compiler/compile.js';
import { formatMinor, parseMoney } from '../src/schema/money.js';
import { makeProfiles } from '../vendor/legacy-core/profiles.js';
import { SessionController } from '../src/control/session.js';
const profile = makeProfiles({ a: 'http://127.0.0.1:4101', b: 'http://127.0.0.1:4102' }).a;
describe('immutable capability contracts', () => {
  it('rejects an edited artifact even when its schema still looks valid', () => {
    const cap = createFixtureCapability();
    cap.steps[0]!.timeoutMs = 99;
    expect(() => verifyDigest(cap)).toThrow('ARTIFACT_DIGEST_MISMATCH');
  });
  it('canonicalizes parameter routes without widening the origin', () => {
    expect(canonicalRoute('/member/100234', profile, { memberId: '100234' })).toEqual({
      template: '/member/:memberId',
      bindings: { memberId: { input: 'memberId' } },
    });
    expect(() =>
      canonicalRoute('https://elsewhere.invalid/member/100234', profile, { memberId: '100234' }),
    ).toThrow();
  });
  it('rejects discovery literals including formatted money and embedded IDs', () => {
    for (const value of ['100234', '/member/100234', '$150.00', '150.00'])
      expect(() =>
        assertNoDiscoveryLiterals(
          { literal: value },
          { memberId: '100234', openingDepositMinor: 15000 },
        ),
      ).toThrow('DISCOVERY_LITERAL');
    expect(() =>
      assertNoDiscoveryLiterals({ key: { input: 'memberId' } }, { memberId: '100234' }),
    ).not.toThrow();
  });
  it('formats money without binary decimal rounding', () => {
    for (const amount of [0, 1, 29, 100, 9999999])
      expect(parseMoney(formatMinor(amount))).toBe(amount);
    expect(() => parseMoney('12.345')).toThrow();
  });
  it('keeps the member row identity mandatory', () => {
    const target = targetFromElement(
      {
        ref: 'e1',
        frame: ['main', 'content'],
        role: 'link',
        tag: 'a',
        name: 'View',
        text: 'View',
        anchors: [
          { by: 'role', role: 'link', name: 'View' },
          { by: 'tableRow', header: 'Member #', key: { const: '100234' }, name: 'View' },
        ],
      },
      profile,
      { memberId: '100234' },
    );
    expect(target.anchors).toHaveLength(1);
    expect(target.required).toEqual([0]);
    expect(target.anchors[0]).toMatchObject({ key: { input: 'memberId' } });
  });
  it('rejects stale actions across human takeover', async () => {
    const controller = new SessionController('test');
    const old = controller.epoch;
    await controller.pause('TEST');
    await controller.takeover();
    await controller.resume();
    let ran = false;
    await expect(
      controller.dispatch(old, async () => {
        ran = true;
      }),
    ).rejects.toThrow('STALE_CONTROL_EPOCH');
    expect(ran).toBe(false);
  });
});
