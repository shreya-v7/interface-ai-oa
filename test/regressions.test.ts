import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSimulator, DEMO_INPUTS, SHADOW_INPUTS } from '../sim/server.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { launchSurface } from '../src/surface/web.js';
import { sealCapability } from '../src/compiler/compile.js';
import { decisionSchema } from '../src/discovery/loop.js';
import { Budget } from '../src/discovery/budget.js';
import { DEMO_CONTRACT, type Target } from '../src/schema/index.js';
import { createFixtureCapability } from './fixture.js';
import { startOperatorServer } from '../src/control/operator-server.js';

let sim: Awaited<ReturnType<typeof startSimulator>>;
beforeAll(async () => {
  sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
});
afterAll(async () => sim.close());

describe('review regressions', () => {
  it('completes a live-session handoff through the operator console HTTP API', async () => {
    const { registerEngine, waitForSettled, initializeRuntime, closeRuns } =
      await import('../src/registry.js');
    const { operatorManager } = await import('../src/control/manager.js');
    const dir = await mkdtemp(join(tmpdir(), 'handoff-'));
    initializeRuntime(join(dir, 'runtime'));
    const journal = join(dir, 'events.jsonl');
    const ticket = sim.createSession({
      tenant: 'a',
      fault: 'session_expired',
      inputs: DEMO_INPUTS,
    });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
      journalPath: journal,
    });
    try {
      // Same sequence as `demo:handoff`: run, register, operator takes over and resumes.
      const entry = registerEngine(engine, 'fixture', 'a');
      entry.result = await engine.run();
      entry.state = entry.result.status;
      expect(entry.result.status).toBe('escalated');
      // Drive the real operator console over HTTP, exactly as its page does.
      const token = 'test-only-operator-token-at-least-32-characters';
      const console_ = await startOperatorServer({ manager: operatorManager, port: 0, token });
      const login = await fetch(`${console_.url}/api/login`, {
        method: 'POST',
        headers: { Origin: console_.url, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const control = (command: string) =>
        fetch(`${console_.url}/api/runs/${engine.runId}/${command}`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: console_.url,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expectedEpoch: engine.session.epoch }),
        });
      const page = engine.surface.page;
      let settled;
      try {
        expect((await control('takeover')).status).toBe(200);
        const frame = page.frames().find((f) => f.name() === sim.profiles.a.frameAliases.content)!;
        await frame.getByLabel('Operator code').fill('demo-unlock');
        await frame.getByRole('button', { name: 'Resume session' }).click();
        await frame.getByRole('heading', { name: 'Savings application', exact: true }).waitFor();
        // A stale epoch is refused: the console must re-read state before acting.
        const stale = await fetch(`${console_.url}/api/runs/${engine.runId}/resume`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: console_.url,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expectedEpoch: engine.session.epoch - 1 }),
        });
        expect(stale.status).toBe(409);
        expect((await control('resume')).status).toBe(200);
        settled = await waitForSettled(engine.runId, 30_000);
      } finally {
        await console_.close();
      }
      expect(settled).toMatchObject({ status: 'success', assisted: true });
      expect(engine.surface.page).toBe(page);
      const events = (await readFile(journal, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const human = events.filter((e) => e.type === 'human_action');
      // Human steps name the vendor control, never the typed value.
      expect(human.map((e) => e.target)).toContain('@label.operatorCode');
      expect(await readFile(journal, 'utf8')).not.toContain('demo-unlock');
    } finally {
      await engine.close();
      await closeRuns();
    }
  });

  it('fills fields captioned only by a neighbouring table cell, and still blocks unlisted ones', async () => {
    const live = await launchSurface({ profile: sim.profiles.a, headless: true });
    try {
      await live.page.route('**/core/members/search', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<h1>Member search</h1><table><tr><td>Member #</td><td><input type="text"></td></tr><tr><td>Tax ID</td><td><input type="text"></td></tr></table>',
        }),
      );
      await live.page.goto(`${sim.profiles.a.origin}/core/members/search`);
      const field = (caption: string): Record<string, Target> => ({
        f: { frame: [], anchors: [{ by: 'label', text: caption }], minAgree: 1, required: [0] },
      });
      const fill = { type: 'fill', target: 'f', value: { input: 'memberId' } } as const;
      await live.surface.act(fill, field('@memberId'), { memberId: '100234' });
      expect(
        await live.surface.resolve(field('@memberId').f!, {}).then((l) => l.inputValue()),
      ).toBe('100234');
      await expect(live.surface.act(fill, field('Tax ID'), { memberId: '100234' })).rejects.toThrow(
        'FILL_TARGET_BLOCKED',
      );
    } finally {
      await live.close();
    }
  });

  it('counts an allowed action that still trips the network guard as an unsafe dispatch', async () => {
    const live = await launchSurface({ profile: sim.profiles.a, headless: true });
    try {
      await live.page.route('**/core/members/search', (route) =>
        route.fulfill({
          contentType: 'text/html',
          // An allowlisted label whose script leaves the allowlist: the gate cannot see it.
          body: `<h1>Member search</h1><button type="button" onclick="location.href='http://example.invalid/exfil'">Search</button>`,
        }),
      );
      await live.page.goto(`${sim.profiles.a.origin}/core/members/search`);
      const targets: Record<string, Target> = {
        b: {
          frame: [],
          anchors: [{ by: 'role', role: 'button', name: 'Search' }],
          minAgree: 1,
          required: [0],
        },
      };
      await live.surface.act({ type: 'click', target: 'b' }, targets, {}).catch(() => {});
      expect(live.surface.metrics.unsafeDispatch).toBe(1);
      expect(live.surface.network?.blocked).toBeGreaterThan(0);
    } finally {
      await live.close();
    }
  });

  it('replays on tenant B, whose form has no <label> or ARIA names', async () => {
    const ticket = sim.createSession({ tenant: 'b', inputs: SHADOW_INPUTS });
    const engine = new ReplayEngine(
      createFixtureCapability(),
      { ...SHADOW_INPUTS },
      sim.profiles.b,
      {
        cookies: [ticket.cookie],
      },
    );
    try {
      expect(await engine.run()).toMatchObject({ status: 'success', outputs: SHADOW_INPUTS });
    } finally {
      await engine.close();
    }
  });

  it('classifies tenant-specific exception wording through the vendor pack', async () => {
    const ticket = sim.createSession({
      tenant: 'b',
      fault: 'member_not_found',
      inputs: DEMO_INPUTS,
    });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.b, {
      cookies: [ticket.cookie],
    });
    try {
      expect(await engine.run()).toMatchObject({
        status: 'business_outcome',
        code: 'MEMBER_NOT_FOUND',
      });
    } finally {
      await engine.close();
    }
  });

  it('accepts a capability whose outputs do not echo every input', async () => {
    const { digest: _, ...base } = createFixtureCapability();
    const { nickname: _n, ...outputs } = base.outputs;
    const cap = sealCapability({
      ...base,
      outputs,
      completion: {
        op: 'all',
        args: [
          { op: 'visible', target: 'review' },
          ...Object.keys(outputs).map((o) => ({
            op: 'outputEquals' as const,
            output: o,
            input: o,
          })),
        ],
      },
    });
    const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
    const engine = new ReplayEngine(cap, { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    try {
      const result = await engine.run();
      expect(result.status).toBe('success');
      expect(result.status === 'success' && Object.keys(result.outputs).sort()).toEqual([
        'memberId',
        'openingDepositMinor',
        'productCode',
      ]);
    } finally {
      await engine.close();
    }
  });

  it('builds the finish decision from the caller contract', () => {
    const schema = decisionSchema({
      ...DEMO_CONTRACT,
      outputs: { balance: { type: 'integer', parser: 'usd_to_minor' } },
    });
    expect(
      schema.safeParse({ kind: 'finish', outputs: { balance: 'e1' }, completionRef: 'e2' }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kind: 'finish',
        outputs: { balance: 'e1', memberId: 'e3' },
        completionRef: 'e2',
      }).success,
    ).toBe(false);
  });

  it('never lets an unverified newer version hide a verified one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caps-'));
    vi.stubEnv('CAPABILITY_DIR', dir);
    vi.resetModules();
    try {
      const reg = await import('../src/registry.js');
      const v1 = createFixtureCapability();
      await reg.saveCapability(v1);
      await reg.markVerified(v1, ['a', 'b'], ['test-evidence']);
      const { digest: _, ...content } = v1;
      await reg.saveCapability(sealCapability({ ...content, version: 2 }));
      expect((await reg.listCapabilities()).map((c) => c.version)).toEqual([1]);
      expect((await reg.loadLatestVerified(v1.id)).version).toBe(1);
      expect(await reg.nextVersion(v1.id)).toBe(3);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('recovers a budget lock left by a dead process but respects a live one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'budget-'));
    const ledger = join(dir, 'ledger.json');
    const budget = new Budget(ledger, 1);
    await writeFile(`${ledger}.lock`, '2147483646');
    await expect(budget.reserve(1000, 100)).resolves.toBeTypeOf('string');
    await writeFile(`${ledger}.lock`, String(process.pid));
    await expect(budget.reserve(1000, 100)).rejects.toThrow('BUDGET_LEDGER_LOCKED');
  });
});
