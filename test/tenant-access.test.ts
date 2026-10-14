import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AccessPolicy, can } from '../src/control/access.js';
import { OidcClient } from '../src/control/oidc.js';
import { startOperatorServer, type OperatorRunSummary } from '../src/control/operator-server.js';
import { LOCAL_SSO_CLIENT_ID, startIdentityProvider } from '../sim/identity.js';

const SECRET = 'synthetic-local-sso-password-used-only-by-tests';
const access = new AccessPolicy({
  version: 1,
  principals: [
    {
      id: 'operator-a',
      kind: 'human',
      subject: 'operator-a',
      grants: [{ tenant: 'a', role: 'operator' }],
    },
    {
      id: 'operator-b',
      kind: 'human',
      subject: 'operator-b',
      grants: [{ tenant: 'b', role: 'operator' }],
    },
    {
      id: 'reviewer-a',
      kind: 'human',
      subject: 'reviewer-a',
      grants: [{ tenant: 'a', role: 'viewer' }],
    },
    {
      id: 'admin',
      kind: 'human',
      subject: 'admin',
      grants: [
        { tenant: 'a', role: 'admin' },
        { tenant: 'b', role: 'admin' },
      ],
    },
    { id: 'agent-a', kind: 'service', grants: [{ tenant: 'a', role: 'agent' }] },
  ],
});

function run(runId: string, tenant: 'a' | 'b', state = 'escalated'): OperatorRunSummary {
  return {
    runId,
    tenant,
    state,
    capability: 'Synthetic savings review',
    epoch: state === 'interrupted' ? 0 : 3,
    owner: 'none',
  };
}
let identity: Awaited<ReturnType<typeof startIdentityProvider>>;
let server: Awaited<ReturnType<typeof startOperatorServer>>;
let browser: Browser;
let runs: OperatorRunSummary[];
const contexts: BrowserContext[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
const control = vi.fn(async () => undefined);

beforeAll(async () => {
  identity = await startIdentityProvider({
    port: 0,
    redirectUris: [],
    accounts: ['operator-a', 'operator-b', 'reviewer-a', 'admin', 'outsider'].map((subject) => ({
      subject,
      secret: SECRET,
    })),
  });
  const oidc = await OidcClient.create({
    issuer: identity.issuer,
    clientId: LOCAL_SSO_CLIENT_ID,
    allowInsecureLoopback: true,
  });
  server = await startOperatorServer({
    port: 0,
    access,
    oidc,
    token: SECRET,
    keyPrincipalId: 'admin',
    manager: { list: () => structuredClone(runs), control },
  });
  identity.registerRedirectUri(`${server.url}/auth/callback`);
  browser = await chromium.launch({ headless: true });
});
beforeEach(() => {
  runs = [
    run('a-live', 'a'),
    run('b-live', 'b'),
    run('a-interrupted', 'a', 'interrupted'),
    run('b-interrupted', 'b', 'interrupted'),
  ];
  control.mockClear();
});
afterEach(async () => {
  await Promise.allSettled(readers.splice(0).map((reader) => reader.cancel()));
  await Promise.allSettled(contexts.splice(0).map((context) => context.close()));
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  await identity?.close();
});

async function signIn(subject: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${server.url}/auth/login`);
  await page.getByLabel('User', { exact: true }).fill(subject);
  await page.getByLabel('Password', { exact: true }).fill(SECRET);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.origin === server.url);
  return page;
}

async function command(page: Page, runId: string, action: string, extra: object = {}) {
  return page.request.post(`${server.url}/api/runs/${runId}/${action}`, {
    headers: { Origin: server.url },
    data: { expectedEpoch: runId.includes('interrupted') ? 0 : 3, ...extra },
  });
}

interface RunList {
  runs: OperatorRunSummary[];
  principal?: { id: string };
}
async function stream(page: Page) {
  const cookies = await page.context().cookies(`${server.url}/api/events`);
  const response = await fetch(`${server.url}/api/events`, {
    headers: { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  readers.push(reader);
  let buffered = '';
  const decoder = new TextDecoder();
  return {
    reader,
    async next(): Promise<RunList> {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          const event = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (event.startsWith('data: ')) return JSON.parse(event.slice(6)) as RunList;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('EVENT_STREAM_CLOSED');
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

it('isolates signed-in tenants in lists and every live event, and revokes only the logged-out session', async () => {
  const [a, b] = await Promise.all([signIn('operator-a'), signIn('operator-b')]);
  for (const [page, tenant] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    const response = await page.request.get(`${server.url}/api/runs`);
    expect(response.status()).toBe(200);
    const data = (await response.json()) as RunList;
    expect(data.principal?.id).toBe(`operator-${tenant}`);
    expect(data.runs.map((entry) => entry.runId).sort()).toEqual([
      `${tenant}-interrupted`,
      `${tenant}-live`,
    ]);
    expect(data.runs.every((entry) => entry.tenant === tenant)).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain('capability_operator');
  }
  const [eventsA, eventsB] = await Promise.all([stream(a), stream(b)]);
  expect((await eventsA.next()).runs.every((entry) => entry.tenant === 'a')).toBe(true);
  expect((await eventsB.next()).runs.every((entry) => entry.tenant === 'b')).toBe(true);
  runs.push(run('a-new', 'a'), run('b-new', 'b'));
  for (const [events, tenant] of [
    [eventsA, 'a'],
    [eventsB, 'b'],
  ] as const) {
    let observed = false;
    for (let attempt = 0; attempt < 3 && !observed; attempt++) {
      const payload = await events.next();
      expect(payload.runs.every((entry) => entry.tenant === tenant)).toBe(true);
      observed = payload.runs.some((entry) => entry.runId === `${tenant}-new`);
    }
    expect(observed).toBe(true);
  }
  const logout = await a.request.post(`${server.url}/api/logout`, {
    headers: { Origin: server.url },
    data: {},
  });
  expect(logout.status()).toBe(200);
  expect((await eventsA.reader.read()).done).toBe(true);
  expect((await a.request.get(`${server.url}/api/runs`)).status()).toBe(401);
  expect((await b.request.get(`${server.url}/api/runs`)).status()).toBe(200);
  runs.push(run('b-after-logout', 'b'));
  expect((await eventsB.next()).runs.some((entry) => entry.runId === 'b-after-logout')).toBe(true);
});

it('denies guessed foreign controls and forged grants before reaching the manager', async () => {
  const a = await signIn('operator-a');
  for (const action of ['takeover', 'resume', 'abort', 'resolve']) {
    const target = action === 'resolve' ? 'b-interrupted' : 'b-live';
    const response = await command(a, target, action, {
      tenant: 'a',
      principal: { id: 'admin' },
      role: 'admin',
    });
    expect(response.status()).toBe(404);
  }
  const missing = await command(a, 'missing-run', 'takeover');
  const foreign = await command(a, 'b-live', 'takeover');
  expect(missing.status()).toBe(foreign.status());
  expect(await missing.json()).toEqual(await foreign.json());
  expect(control).not.toHaveBeenCalled();
  expect((await command(a, 'a-live', 'takeover')).status()).toBe(200);
  expect(control).toHaveBeenCalledExactlyOnceWith(
    'a-live',
    'takeover',
    3,
    access.principal('operator-a'),
  );
});

it('revokes the previous session and stream before switching SSO accounts in one browser', async () => {
  const page = await signIn('operator-a');
  const priorCookies = (await page.context().cookies(`${server.url}/api/runs`))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  const events = await stream(page);
  expect((await events.next()).principal?.id).toBe('operator-a');

  await page.goto(`${server.url}/auth/login`);
  await page.getByLabel('User', { exact: true }).waitFor();
  expect((await events.reader.read()).done).toBe(true);
  expect(
    (await fetch(`${server.url}/api/runs`, { headers: { Cookie: priorCookies } })).status,
  ).toBe(401);
  await page.getByLabel('User', { exact: true }).fill('operator-b');
  await page.getByLabel('Password', { exact: true }).fill(SECRET);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.origin === server.url);
  const current = await page.request.get(`${server.url}/api/runs`);
  expect(((await current.json()) as RunList).principal?.id).toBe('operator-b');
  expect(
    (await fetch(`${server.url}/api/runs`, { headers: { Cookie: priorCookies } })).status,
  ).toBe(401);

  const logout = await page.request.post(`${server.url}/api/logout`, {
    headers: { Origin: server.url },
    data: {},
  });
  expect(logout.status()).toBe(200);
  expect((await page.request.get(`${server.url}/api/runs`)).status()).toBe(401);
});

it('keeps reviewers read-only and reserves interrupted-run resolution for an administrator', async () => {
  const reviewer = await signIn('reviewer-a');
  expect((await reviewer.request.get(`${server.url}/api/runs`)).status()).toBe(200);
  for (const action of ['takeover', 'resume', 'abort', 'resolve']) {
    const response = await command(
      reviewer,
      action === 'resolve' ? 'a-interrupted' : 'a-live',
      action,
    );
    expect(response.status()).toBe(403);
  }
  const operator = await signIn('operator-a');
  expect((await command(operator, 'a-interrupted', 'resolve')).status()).toBe(403);
  expect(control).not.toHaveBeenCalled();
  const admin = await signIn('admin');
  expect((await command(admin, 'b-interrupted', 'resolve')).status()).toBe(200);
  expect(control).toHaveBeenCalledExactlyOnceWith(
    'b-interrupted',
    'resolve',
    0,
    access.principal('admin'),
  );
});

it('does not grant a console session to a correctly signed but unmapped SSO identity', async () => {
  const outsider = await signIn('outsider');
  expect((await outsider.request.get(`${server.url}/api/runs`)).status()).toBe(401);
  expect((await outsider.request.get(`${server.url}/api/events`)).status()).toBe(401);
  expect((await command(outsider, 'a-live', 'takeover')).status()).toBe(401);
  expect(control).not.toHaveBeenCalled();
});

it('rejects ambiguous identities and keeps service grants separate from human grants', () => {
  expect(() => access.principal('agent-a', 'human')).toThrow('ACCESS_DENIED');
  expect(() => access.forSubject('agent-a')).toThrow('ACCESS_DENIED');
  expect(() => access.forSubject('not-configured')).toThrow('ACCESS_DENIED');
  const agent = access.principal('agent-a', 'service');
  expect(can(agent, 'a', 'invoke')).toBe(true);
  expect(can(agent, 'b', 'invoke')).toBe(false);
  expect(can(agent, 'a', 'control')).toBe(false);
  expect(can(agent, 'a', 'resolve')).toBe(false);
  expect(
    () =>
      new AccessPolicy({
        version: 1,
        principals: [
          {
            id: 'first',
            kind: 'human',
            subject: 'shared-subject',
            grants: [{ tenant: 'a', role: 'operator' }],
          },
          {
            id: 'second',
            kind: 'human',
            subject: 'shared-subject',
            grants: [{ tenant: 'b', role: 'admin' }],
          },
        ],
      }),
  ).toThrow('ACCESS_POLICY_INVALID');
});
