import { it, expect, vi } from 'vitest';
import { chromium } from 'playwright';
import { chmod, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOperatorServer } from '../src/control/operator-server.js';
import {
  initializeOperatorCredential,
  OperatorAuth,
  OPERATOR_COOKIE,
  OPERATOR_SESSION_MS,
  sessionCookie,
} from '../src/control/auth.js';

const TOKEN = 'synthetic-operator-key-for-tests-only-938475';

it('operator console renders live updates and submits fenced, authenticated control', async () => {
  let owner = 'none',
    state = 'awaiting_human',
    epoch = 1;
  const commands: string[] = [];
  const server = await startOperatorServer({
    port: 0,
    token: TOKEN,
    manager: {
      list: () => [
        {
          runId: 'operator-test',
          tenant: 'a',
          capability: 'Synthetic savings review',
          state,
          epoch,
          owner,
          reason: 'SESSION_EXPIRED',
        },
      ],
      control: async (_id, command, expected) => {
        if (expected !== epoch) throw new Error('STALE');
        commands.push(command);
        epoch++;
        owner = command === 'takeover' ? 'human' : 'automation';
        state = command === 'takeover' ? 'human' : 'running';
      },
    },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.context().addCookies([
      {
        name: OPERATOR_COOKIE,
        value: 'a'.repeat(64),
        domain: '127.0.0.1',
        path: '/api',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    await page.goto(server.url);
    await page.getByRole('heading', { name: 'Operator sign in' }).waitFor();
    await expect(
      page.getByRole('heading', { name: 'Synthetic savings review' }).count(),
    ).resolves.toBe(0);
    expect(await page.content()).not.toContain(TOKEN);
    await page.getByLabel('Operator key').fill(TOKEN);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Synthetic savings review' }).waitFor();
    const operatorCookies = (await page.context().cookies(`${server.url}/api/runs`)).filter(
      (cookie) => cookie.name === OPERATOR_COOKIE,
    );
    expect(operatorCookies).toHaveLength(1);
    expect(operatorCookies[0]?.path).toBe('/');
    expect(await page.evaluate(() => document.cookie)).not.toContain(OPERATOR_COOKIE);
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByText('Human in control').waitFor();
    expect(commands).toEqual(['takeover']);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.getByText('Automation in control').waitFor();
    expect(commands).toEqual(['takeover', 'resume']);
    const blocked = await fetch(`${server.url}/api/runs/operator-test/takeover`, {
      method: 'POST',
      headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedEpoch: epoch }),
    });
    expect(blocked.status).toBe(403);
    const unauthenticated = await fetch(`${server.url}/api/runs`);
    expect(unauthenticated.status).toBe(401);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('heading', { name: 'Operator sign in' }).waitFor();
    expect(await page.getByRole('heading', { name: 'Synthetic savings review' }).count()).toBe(0);
  } finally {
    await browser.close();
    await server.close();
  }
});

it('rejects unauthenticated controls, cross-origin requests, expired sessions and logged-out streams', async () => {
  let now = 1_000_000;
  const control = vi.fn(async () => undefined);
  const server = await startOperatorServer({
    port: 0,
    token: TOKEN,
    now: () => now,
    manager: { list: () => [], control },
  });
  const post = (path: string, body: unknown = {}, cookie?: string, origin = server.url) =>
    fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await fetch(`${server.url}/api/events`)).status).toBe(401);
    expect((await post('/api/runs/private-run/abort', { expectedEpoch: 0 })).status).toBe(401);
    expect(
      (await post('/api/login', { token: TOKEN }, undefined, 'https://evil.invalid')).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${server.url}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN }),
        })
      ).status,
    ).toBe(403);
    expect((await post('/api/login', { token: 'wrong' })).status).toBe(401);
    const loggedIn = await post('/api/login', { token: TOKEN });
    expect(loggedIn.status).toBe(200);
    const setCookie = loggedIn.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly; SameSite=Strict; Path=/; Max-Age=900');
    expect(setCookie).toContain('Path=/api; Max-Age=0');
    expect(setCookie).not.toContain(TOKEN);
    const cookie = setCookie.split(';')[0]!;
    expect((await fetch(`${server.url}/api/runs`, { headers: { Cookie: cookie } })).status).toBe(
      200,
    );
    expect(
      (
        await post(
          '/api/runs/private-run/abort',
          { expectedEpoch: 0 },
          cookie,
          'https://evil.invalid',
        )
      ).status,
    ).toBe(403);
    expect((await post('/api/runs/private-run/abort', { expectedEpoch: -1 }, cookie)).status).toBe(
      400,
    );
    const stream = await fetch(`${server.url}/api/events`, { headers: { Cookie: cookie } });
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await post('/api/logout', {}, cookie)).status).toBe(200);
    expect((await reader.read()).done).toBe(true);
    expect((await fetch(`${server.url}/api/runs`, { headers: { Cookie: cookie } })).status).toBe(
      401,
    );
    const second = await post('/api/login', { token: TOKEN });
    const secondCookie = second.headers.get('set-cookie')!.split(';')[0]!;
    const expiringStream = await fetch(`${server.url}/api/events`, {
      headers: { Cookie: secondCookie },
    });
    const expiringReader = expiringStream.body!.getReader();
    await expiringReader.read();
    now += OPERATOR_SESSION_MS;
    expect(
      (await fetch(`${server.url}/api/runs`, { headers: { Cookie: secondCookie } })).status,
    ).toBe(401);
    expect((await expiringReader.read()).done).toBe(true);
    expect(control).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

it('bounds password attempts and session count, rejects duplicate cookies, and never stores credentials in cookies', () => {
  let now = 1_000_000;
  const auth = new OperatorAuth(TOKEN, () => now);
  for (let i = 0; i < 5; i++) expect(auth.login('bad')).toEqual({ error: 'AUTH_REJECTED' });
  expect(auth.login(TOKEN)).toEqual({ error: 'LOGIN_RATE_LIMITED' });
  now += 60_000;
  const sessions: string[] = [];
  for (let i = 0; i < 9; i++) {
    const result = auth.login(TOKEN);
    expect('session' in result).toBe(true);
    if ('session' in result) sessions.push(sessionCookie(result.session).split(';')[0]!);
  }
  expect(auth.authenticate(sessions[0])).toBeUndefined();
  expect(auth.authenticate(sessions[1])).toBeDefined();
  expect(auth.authenticate(`${sessions[1]}; ${sessions[1]}`)).toBeUndefined();
  auth.clear();
  expect(auth.authenticate(sessions[8])).toBeUndefined();
  expect(() => new OperatorAuth('short')).toThrow('OPERATOR_TOKEN_INVALID');
});

it('creates a private local credential and refuses unsafe existing key files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'operator-auth-'));
  vi.stubEnv('OPERATOR_TOKEN', undefined);
  try {
    const path = join(dir, 'operator-key');
    const first = await initializeOperatorCredential({ path });
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, 'utf8')).trim()).toBe(first.token);
    expect(await initializeOperatorCredential({ path })).toEqual({ ...first, created: false });
    await chmod(path, 0o644);
    await expect(initializeOperatorCredential({ path })).rejects.toThrow(
      'OPERATOR_KEY_PERMISSIONS',
    );
    await chmod(path, 0o600);
    const linked = join(dir, 'symlink');
    await symlink(path, linked);
    await expect(initializeOperatorCredential({ path: linked })).rejects.toThrow();
    await expect(initializeOperatorCredential({ path, envToken: 'short' })).rejects.toThrow(
      'OPERATOR_TOKEN_INVALID',
    );
    expect(await initializeOperatorCredential({ path, envToken: TOKEN })).toEqual({
      token: TOKEN,
      created: false,
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it('requires a signed-in operator to acknowledge interrupted runs without replaying them', async () => {
  let state = 'interrupted';
  const control = vi.fn(async (_id: string, command: string) => {
    expect(command).toBe('resolve');
    state = 'closed';
  });
  const server = await startOperatorServer({
    port: 0,
    token: TOKEN,
    manager: {
      list: () => [
        {
          runId: 'lost-worker',
          tenant: 'a',
          capability: 'Savings',
          state,
          epoch: 0,
          owner: 'none',
        },
      ],
      control,
    },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.getByLabel('Operator key').fill(TOKEN);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Browser session was lost.', { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: 'Resume', exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Acknowledge interruption' }).click();
    await page.getByText('Closed', { exact: true }).waitFor();
    expect(control).toHaveBeenCalledExactlyOnceWith(
      'lost-worker',
      'resolve',
      0,
      expect.objectContaining({ id: 'local_operator', kind: 'human' }),
    );
    expect(await page.getByRole('button', { name: 'Resume', exact: true }).isDisabled()).toBe(true);
  } finally {
    await browser.close();
    await server.close();
  }
});
