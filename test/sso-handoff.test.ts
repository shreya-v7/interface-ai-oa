import { expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIdentityProvider, LOCAL_SSO_CLIENT_ID } from '../sim/identity.js';
import { startSimulator, DEMO_INPUTS } from '../sim/server.js';
import { OidcClient } from '../src/control/oidc.js';
import { startOperatorServer } from '../src/control/operator-server.js';
import { configuredOperatorAuth } from '../src/control/operator-config.js';
import { operatorManager } from '../src/control/manager.js';
import { closeRuns, registerEngine, initializeRuntime, runStatus } from '../src/registry.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { createFixtureCapability } from './fixture.js';

it('signs in through SSO and resumes the same live bank session to a verified result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sso-handoff-'));
  vi.stubEnv('RUN_STATE_DIR', directory);
  const secret = 'synthetic-live-handoff-password-for-local-tests';
  const sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
  const identity = await startIdentityProvider({
    port: 0,
    redirectUris: [],
    accounts: [{ subject: 'operator-a', secret }],
  });
  const oidc = await OidcClient.create({
    issuer: identity.issuer,
    clientId: LOCAL_SSO_CLIENT_ID,
    allowInsecureLoopback: true,
  });
  const server = await startOperatorServer({ port: 0, oidc, manager: operatorManager });
  identity.registerRedirectUri(`${server.url}/auth/callback`);
  const browser = await chromium.launch({ headless: true });
  try {
    initializeRuntime(directory);
    const ticket = sim.createSession({
      tenant: 'a',
      inputs: DEMO_INPUTS,
      fault: 'session_expired',
    });
    const engine = new ReplayEngine(createFixtureCapability(), { ...DEMO_INPUTS }, sim.profiles.a, {
      cookies: [ticket.cookie],
    });
    registerEngine(engine, engine.capability.id, 'a');
    expect(await engine.run()).toMatchObject({ status: 'escalated', reason: 'SESSION_EXPIRED' });
    const bankPage = engine.surface.page;
    const consolePage = await browser.newPage();
    await consolePage.goto(server.url);
    expect(await consolePage.getByLabel('Operator key').count()).toBe(0);
    expect(
      (
        await consolePage.request.post(`${server.url}/api/login`, {
          headers: { Origin: server.url },
          data: { token: secret },
        })
      ).status(),
    ).toBe(403);
    await consolePage.getByRole('link', { name: 'Sign in with SSO' }).click();
    await consolePage.getByLabel('User', { exact: true }).fill('operator-a');
    await consolePage.getByLabel('Password', { exact: true }).fill(secret);
    await consolePage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await consolePage.getByRole('button', { name: 'Take control', exact: true }).click();
    await consolePage.getByText('Human in control').waitFor();
    expect(engine.surface.page).toBe(bankPage);
    expect(engine.session.owner).toBe('human');
    const stale = await consolePage.request.post(`${server.url}/api/runs/${engine.runId}/resume`, {
      headers: { Origin: server.url },
      data: { expectedEpoch: engine.session.epoch - 1 },
    });
    expect(stale.status()).toBe(409);
    expect(engine.session.owner).toBe('human');
    const frame = bankPage.frame({ name: sim.profiles.a.frameAliases.content })!;
    await frame.getByLabel('Operator code').fill('demo-unlock');
    await frame.getByRole('button', { name: 'Resume session' }).click();
    await consolePage.getByRole('button', { name: 'Resume', exact: true }).click();
    await consolePage.getByText('Completed', { exact: true }).waitFor();
    expect(runStatus(engine.runId)).toMatchObject({
      state: 'success',
      result: { outputs: DEMO_INPUTS },
    });
    const actual = sim.inspectSession(ticket.sessionId);
    expect(actual.draft).toEqual(DEMO_INPUTS);
    expect(actual.forbiddenCommitCount).toBe(0);
    expect(actual.events.filter((event) => event.kind === 'draft_prepared')).toHaveLength(1);
  } finally {
    await browser.close();
    await server.close();
    await closeRuns();
    await identity.close();
    await sim.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails closed on incomplete or unknown SSO configuration', async () => {
  try {
    vi.stubEnv('OPERATOR_AUTH', 'oidc');
    vi.stubEnv('OIDC_ISSUER', undefined);
    vi.stubEnv('OIDC_CLIENT_ID', undefined);
    await expect(configuredOperatorAuth()).rejects.toThrow('OPERATOR_AUTH_CONFIGURATION_INVALID');
    vi.stubEnv('OPERATOR_AUTH', 'unknown');
    await expect(configuredOperatorAuth()).rejects.toThrow('OPERATOR_AUTH_CONFIGURATION_INVALID');
  } finally {
    vi.unstubAllEnvs();
  }
});
