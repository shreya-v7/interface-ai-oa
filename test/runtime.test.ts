import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { startSimulator, DEMO_INPUTS, SHADOW_INPUTS, type Fault } from '../sim/server.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { createFixtureCapability } from './fixture.js';
import { inspectDisplayedReview, reviewEquals } from '../eval/oracle.js';
let sim: Awaited<ReturnType<typeof startSimulator>>;
beforeAll(async () => {
  sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
});
afterAll(async () => {
  await sim?.close();
});
describe('real browser execution of a labeled handwritten fixture', () => {
  it.each(['a', 'b'] as const)('returns exact review fields on tenant %s', async (tenant) => {
    const inputs = { ...SHADOW_INPUTS };
    const ticket = sim.createSession({ tenant, inputs });
    const engine = new ReplayEngine(createFixtureCapability(), inputs, sim.profiles[tenant], {
      cookies: [ticket.cookie],
    });
    try {
      const result = await engine.run();
      expect(result, JSON.stringify({ result, step: engine.stepIndex })).toMatchObject({
        status: 'success',
        outputs: inputs,
      });
      const review = await inspectDisplayedReview(
        engine.surface.page,
        sim.profiles[tenant].labelAliases as never,
      );
      expect(reviewEquals(inputs, review)).toBe(true);
      expect(sim.inspectSession(ticket.sessionId).forbiddenCommitCount).toBe(0);
    } finally {
      await engine.close();
    }
  });
  it.each([
    ['member_not_found', 'business_outcome', 'MEMBER_NOT_FOUND'],
    ['validation_min_deposit', 'business_outcome', 'VALIDATION_REJECTED'],
    ['permission_denied', 'failed', 'PERMISSION_DENIED'],
    ['wrong_member_review', 'failed', 'COMPLETION_MISMATCH'],
    ['wrong_amount_review', 'failed', 'COMPLETION_MISMATCH'],
    ['ambiguous_duplicate_button', 'escalated', undefined],
    ['interstitial_notice', 'success', undefined],
    ['app_error_500', 'success', undefined],
  ] as const)('classifies %s', async (fault, status, code) => {
    const ticket = sim.createSession({ tenant: 'a', fault: fault as Fault, inputs: DEMO_INPUTS });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      const result = await engine.run();
      expect(result.status).toBe(status);
      if (code) expect(result).toMatchObject({ code });
      expect(sim.inspectSession(ticket.sessionId).forbiddenCommitCount).toBe(0);
    } finally {
      await engine.close();
    }
  });
  it('hands the exact session to an operator and reconciles the suspended step', async () => {
    const ticket = sim.createSession({
      tenant: 'a',
      fault: 'session_expired',
      inputs: DEMO_INPUTS,
    });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      expect((await engine.run()).status).toBe('escalated');
      const page = engine.surface.page;
      const context = page.context();
      await engine.takeover();
      const frame = page.frames().find((f) => f.name() === sim.profiles.a.frameAliases.content)!;
      await frame.getByLabel('Operator code').fill('demo-unlock');
      await frame.getByRole('button', { name: 'Resume session' }).click();
      await frame.getByRole('heading', { name: 'Savings application', exact: true }).waitFor();
      expect((await engine.resume()).status).toBe('success');
      expect(engine.surface.page).toBe(page);
      expect(engine.surface.page.context()).toBe(context);
      expect(engine.assisted).toBe(true);
    } finally {
      await engine.close();
    }
  });
  it('refuses a resume after the operator opens the wrong member', async () => {
    const ticket = sim.createSession({
      tenant: 'a',
      fault: 'session_expired',
      inputs: DEMO_INPUTS,
    });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      expect((await engine.run()).status).toBe('escalated');
      await engine.takeover('test_operator');
      const frame = engine.surface.page
        .frames()
        .find((f) => f.name() === sim.profiles.a.frameAliases.content)!;
      await frame.getByLabel('Operator code').fill('demo-unlock');
      await frame.getByRole('button', { name: 'Resume session' }).click();
      await frame.getByRole('heading', { name: 'Savings application', exact: true }).waitFor();
      await frame.goto(`${sim.profiles.a.origin}/core/members/detail?memberId=000001`);
      expect(await engine.resume()).toMatchObject({
        status: 'escalated',
        reason: 'WRONG_SUBJECT_ON_RESUME',
      });
      expect(engine.session.owner).not.toBe('automation');
    } finally {
      await engine.close();
    }
  });
  it('returns a structured session-loss failure instead of rebuilding the browser', async () => {
    const ticket = sim.createSession({
      tenant: 'a',
      fault: 'session_expired',
      inputs: DEMO_INPUTS,
    });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      expect((await engine.run()).status).toBe('escalated');
      await engine.surface.page.close();
      expect(await engine.resume()).toMatchObject({
        status: 'failed',
        code: 'SESSION_LOST',
        effect: 'unknown',
      });
    } finally {
      await engine.close();
    }
  });
  it('quiesces an in-flight navigation before granting human control and safely resumes', async () => {
    const ticket = sim.createSession({ tenant: 'a', fault: 'slow_load', inputs: DEMO_INPUTS });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      const running = engine.run();
      await vi.waitFor(() => expect(engine.surface?.metrics.actionCount).toBeGreaterThanOrEqual(3));
      await engine.takeover('test_operator');
      expect((await running).status).toBe('escalated');
      expect(engine.session.owner).toBe('human');
      expect(engine.session.state).toBe('human');
      const actions = engine.surface.metrics.actionCount;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(engine.surface.metrics.actionCount).toBe(actions);
      expect(await engine.resume()).toMatchObject({ status: 'success', assisted: true });
    } finally {
      await engine.close();
    }
  });
  it('fails closed when the subject screen loses its member identity', async () => {
    const ticket = sim.createSession({
      tenant: 'a',
      fault: 'session_expired',
      inputs: DEMO_INPUTS,
    });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      expect((await engine.run()).status).toBe('escalated');
      await engine.takeover('test_operator');
      const frame = engine.surface.page
        .frames()
        .find((f) => f.name() === sim.profiles.a.frameAliases.content)!;
      await frame.getByLabel('Operator code').fill('demo-unlock');
      await frame.getByRole('button', { name: 'Resume session' }).click();
      await frame.getByRole('heading', { name: 'Savings application', exact: true }).waitFor();
      await frame.locator('strong').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
      expect(await engine.resume()).toMatchObject({
        status: 'escalated',
        reason: 'WRONG_SUBJECT_ON_RESUME',
      });
      expect(sim.inspectSession(ticket.sessionId).draft).toBeNull();
    } finally {
      await engine.close();
    }
  });
  it('allows human acknowledgement of a dismissed native dialog before resynchronizing', async () => {
    const ticket = sim.createSession({
      tenant: 'a',
      fault: 'session_expired',
      inputs: DEMO_INPUTS,
    });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      expect((await engine.run()).status).toBe('escalated');
      await engine.surface.page.evaluate(() => alert('Synthetic unexpected dialog'));
      expect(await engine.resume()).toMatchObject({
        status: 'escalated',
        reason: 'NATIVE_DIALOG_REQUIRES_HUMAN',
      });
      await engine.takeover('test_operator');
      const frame = engine.surface.page
        .frames()
        .find((f) => f.name() === sim.profiles.a.frameAliases.content)!;
      await frame.getByLabel('Operator code').fill('demo-unlock');
      await frame.getByRole('button', { name: 'Resume session' }).click();
      await frame.getByRole('heading', { name: 'Savings application', exact: true }).waitFor();
      expect(await engine.resume()).toMatchObject({ status: 'success', assisted: true });
    } finally {
      await engine.close();
    }
  });
});
