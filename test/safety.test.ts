import { describe, it, expect, vi } from 'vitest';
import { startSimulator, DEMO_INPUTS } from '../sim/server.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { createFixtureCapability } from './fixture.js';
import { safeEvent } from '../src/policy/events.js';
import { readFile } from 'node:fs/promises';
import { launchSurface } from '../src/surface/web.js';

describe('safety boundaries', () => {
  it('rejects an old action when takeover occurs during asynchronous target resolution', async () => {
    const sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
    const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
    const live = await launchSurface({
      profile: sim.profiles.a,
      startURL: ticket.entryUrl,
      cookies: [ticket.cookie],
    });
    let unblock!: () => void;
    let reached!: () => void;
    const pausedResolution = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resolveTarget = live.surface.resolve.bind(live.surface);
    // act() resolves through the private resolveRecord seam; pause it mid-resolution.
    const seam = live.surface as unknown as {
      resolveRecord: (...args: unknown[]) => Promise<unknown>;
    };
    const resolveRecord = seam.resolveRecord.bind(live.surface);
    const spy = vi.spyOn(seam, 'resolveRecord').mockImplementation(async (...args) => {
      const record = await resolveRecord(...args);
      reached();
      await pausedResolution;
      return record;
    });
    try {
      const cap = createFixtureCapability();
      const action = live.surface.act(
        { type: 'fill', target: 'member', value: { input: 'memberId' } },
        cap.targets,
        { ...DEMO_INPUTS },
      );
      const rejected = expect(action).rejects.toThrow('CONTROL_NOT_AUTOMATION');
      await entered;
      const takeover = live.session.takeover('test_operator');
      expect(live.session.owner).toBe('none');
      unblock();
      await rejected;
      await takeover;
      expect(live.surface.metrics.actionCount).toBe(0);
      const field = await resolveTarget(cap.targets.member!, { ...DEMO_INPUTS });
      expect(await field.inputValue()).toBe('');
      expect(live.session.owner).toBe('human');
    } finally {
      unblock();
      spy.mockRestore();
      await live.close();
      await sim.close();
    }
  });
  it('does not persist unapproved value-bearing log fields', () => {
    const sentinel = 'SENTINEL_PRIVATE_9H3';
    const event = safeEvent({
      type: 'failure',
      code: 'CHECKPOINT_TIMEOUT',
      value: sentinel,
      error: sentinel,
      url: `/member/${sentinel}`,
      prompt: sentinel,
      observation: { text: sentinel },
    });
    expect(JSON.stringify(event)).not.toContain(sentinel);
  });
  it('keeps discovery imports out of the replay dependency path', async () => {
    for (const file of [
      'src/replay/engine.ts',
      'src/surface/web.ts',
      'src/policy/gate.ts',
      'src/control/session.ts',
      'src/compiler/compile.ts',
      'src/registry.ts',
      'src/mcp/server.ts',
    ]) {
      const code = await readFile(file, 'utf8');
      expect(code).not.toMatch(/from\s+['"][^'"]*(?:discovery|bedrock|openai|anthropic|@aws-sdk)/i);
    }
  });
  it('blocks final creation by policy and by keyboard-triggered network submission during human control', async () => {
    const sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
    const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      expect((await engine.run()).status).toBe('success');
      const target = {
        frame: ['main', 'content'],
        anchors: [{ by: 'role' as const, role: 'button', name: 'Open Account' }],
        minAgree: 1,
        required: [0],
      };
      await expect(
        engine.surface.act(
          { type: 'click', target: 'commit' },
          { commit: target },
          { ...DEMO_INPUTS },
        ),
      ).rejects.toThrow('RISKY_OR_UNKNOWN_TARGET');
      await engine.session.pause('SAFETY_TEST');
      // Exercise the lower-level guard after the completed run; the public engine
      // correctly refuses takeover of a terminal capability.
      await engine.session.takeover('test_operator');
      const frame = engine.surface.page
        .frames()
        .find((f) => f.name() === sim.profiles.a.frameAliases.content)!;
      await frame
        .getByRole('button', { name: 'Open Account', exact: true })
        .press('Enter')
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sim.inspectSession(ticket.sessionId).forbiddenCommitCount).toBe(0);
      expect(engine.surface.network!.blocked).toBeGreaterThan(0);
    } finally {
      await engine.close();
      await sim.close();
    }
  });
});
