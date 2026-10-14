import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { get } from 'node:http';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { LOCAL_SSO_CLIENT_ID, startIdentityProvider } from '../sim/identity.js';

const redirectUri = 'http://127.0.0.1:4199/auth/callback';
const secret = 'synthetic-operator-secret-0123456789abcdef';
const account = { subject: 'operator-a', secret };
type Provider = Awaited<ReturnType<typeof startIdentityProvider>>;
const providers: Provider[] = [];
const directories: string[] = [];

async function start(): Promise<Provider> {
  const provider = await startIdentityProvider({
    port: 0,
    redirectUris: [redirectUri],
    accounts: [account],
  });
  providers.push(provider);
  return provider;
}

async function transaction(provider: Provider, overrides: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: LOCAL_SSO_CLIENT_ID,
    scope: 'openid',
    redirect_uri: redirectUri,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...overrides,
  });
  const response = await fetch(`${provider.issuer}/authorize?${query}`, { redirect: 'manual' });
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { response, html, csrf, cookie, verifier, nonce, state, query };
}

async function login(
  provider: Provider,
  tx: Awaited<ReturnType<typeof transaction>>,
  overrides: Record<string, string> = {},
) {
  return fetch(`${provider.issuer}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: provider.issuer,
      cookie: tx.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrf: tx.csrf,
      username: account.subject,
      password: account.secret,
      ...overrides,
    }),
  });
}

async function authorized(provider: Provider) {
  const tx = await transaction(provider);
  expect(tx.response.status).toBe(200);
  const response = await login(provider, tx);
  expect(response.status).toBe(303);
  const destination = new URL(response.headers.get('location')!);
  return { ...tx, destination, code: destination.searchParams.get('code')! };
}

async function exchange(
  provider: Provider,
  authorization: Awaited<ReturnType<typeof authorized>>,
  overrides: Record<string, string> = {},
) {
  return fetch(`${provider.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorization.code,
      client_id: LOCAL_SSO_CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: authorization.verifier,
      ...overrides,
    }),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('local identity provider', () => {
  it('completes a real authorization code exchange and publishes a verifiable RS256 identity', async () => {
    const provider = await start();
    const metadata = await fetch(`${provider.issuer}/.well-known/openid-configuration`).then(
      (response) => response.json(),
    );
    expect(metadata).toMatchObject({
      issuer: provider.issuer,
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
    const authorization = await authorized(provider);
    expect(authorization.html).not.toContain(secret);
    expect(authorization.destination.origin + authorization.destination.pathname).toBe(redirectUri);
    expect(authorization.destination.searchParams.get('state')).toBe(authorization.state);
    expect(authorization.destination.searchParams.get('iss')).toBe(provider.issuer);
    const response = await exchange(provider, authorization);
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as { id_token: string; token_type: string };
    const keys = await fetch(`${provider.issuer}/jwks`).then((result) => result.json());
    const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(keys), {
      issuer: provider.issuer,
      audience: LOCAL_SSO_CLIENT_ID,
      algorithms: ['RS256'],
    });
    expect(verified.payload).toMatchObject({ sub: account.subject, nonce: authorization.nonce });
    expect(tokens.token_type).toBe('Bearer');
    expect(verified.payload.exp! - verified.payload.iat!).toBe(300);
    expect((await exchange(provider, authorization)).status).toBe(400);
  });

  it('rejects unregistered redirects, wrong clients, duplicate parameters and missing PKCE', async () => {
    const provider = await start();
    for (const overrides of [
      { redirect_uri: 'https://attacker.invalid/auth/callback' },
      { redirect_uri: `${redirectUri}/extra` },
      { client_id: 'attacker' },
      { code_challenge_method: 'plain' },
      { code_challenge: '' },
      { response_type: 'token' },
      { response_mode: 'fragment' },
      { state: '' },
      { nonce: '' },
    ] as Record<string, string>[])
      expect((await transaction(provider, overrides)).response.status).toBe(400);
    const tx = await transaction(provider);
    const duplicate = await fetch(`${provider.issuer}/authorize?${tx.query}&client_id=attacker`, {
      redirect: 'manual',
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.headers.get('location')).toBeNull();
  });

  it('requires the matching transaction cookie, CSRF value and same-origin login', async () => {
    const provider = await start();
    const tx = await transaction(provider);
    expect(tx.response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await login(provider, { ...tx, cookie: '' })).status).toBe(403);
    expect((await login(provider, tx, { csrf: 'wrong' })).status).toBe(403);
    const denied = await fetch(`${provider.issuer}/login?ignored=1`, {
      method: 'POST',
      headers: { cookie: tx.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: tx.csrf, username: account.subject, password: secret }),
    });
    expect(denied.status).toBe(403);
    expect((await login(provider, tx)).status).toBe(303);
    expect((await login(provider, tx)).status).toBe(403);
  });

  it('bounds password guessing without disclosing whether a username exists', async () => {
    const provider = await start();
    const tx = await transaction(provider);
    const unknown = await login(provider, tx, { username: 'missing-user', password: 'wrong' });
    const known = await login(provider, tx, { password: 'wrong' });
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).toBe(await known.text());
    for (let attempt = 0; attempt < 4; attempt++)
      expect((await login(provider, tx, { password: 'wrong' })).status).toBe(401);
    expect((await login(provider, tx)).status).toBe(429);
  });

  it('burns each code on a failed verifier, client or redirect binding', async () => {
    const provider = await start();
    for (const overrides of [
      { code_verifier: randomBytes(32).toString('base64url') },
      { client_id: 'wrong-client' },
      { redirect_uri: 'http://127.0.0.1:4198/auth/callback' },
    ] as Record<string, string>[]) {
      const authorization = await authorized(provider);
      expect((await exchange(provider, authorization, overrides)).status).toBe(400);
      expect((await exchange(provider, authorization)).status).toBe(400);
    }
  });

  it('allows exactly one token response for concurrent code exchanges', async () => {
    const provider = await start();
    const authorization = await authorized(provider);
    const responses = await Promise.all([
      exchange(provider, authorization),
      exchange(provider, authorization),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it('expires codes and login transactions', async () => {
    const provider = await start();
    const authorization = await authorized(provider);
    const tx = await transaction(provider);
    const future = Date.now() + 301_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    expect((await exchange(provider, authorization)).status).toBe(400);
    expect((await login(provider, tx)).status).toBe(403);
  });

  it('rejects host spoofing, cross-origin requests and token JSON bodies', async () => {
    const provider = await start();
    // Native fetch rewrites Host; use an actual HTTP request to send the hostile value.
    const spoofedStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${provider.issuer}/jwks`, { headers: { host: 'attacker.invalid' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(spoofedStatus).toBe(403);
    expect(
      (await fetch(`${provider.issuer}/jwks`, { headers: { origin: 'https://attacker.invalid' } }))
        .status,
    ).toBe(403);
    const response = await fetch(`${provider.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
  });

  it('registers exact local callbacks through the trusted startup API only', async () => {
    const provider = await startIdentityProvider({
      port: 0,
      redirectUris: [],
      accounts: [account],
    });
    providers.push(provider);
    expect((await transaction(provider)).response.status).toBe(400);
    provider.registerRedirectUri(redirectUri);
    expect((await transaction(provider)).response.status).toBe(200);
    for (const uri of [
      'https://attacker.invalid/auth/callback',
      `${redirectUri}?next=x`,
      'http://127.0.0.1:4199/other',
    ])
      expect(() => provider.registerRedirectUri(uri)).toThrow();
  });

  it('creates stable private credentials and rejects unsafe credential files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-sso-'));
    directories.push(directory);
    const credentialPath = join(directory, 'users.json');
    const first = await startIdentityProvider({ port: 0, redirectUris: [], credentialPath });
    await first.close();
    const content = await readFile(credentialPath, 'utf8');
    const data = JSON.parse(content) as { accounts: { subject: string; secret: string }[] };
    expect(data.accounts.map((entry) => entry.subject)).toEqual([
      'operator-a',
      'operator-b',
      'reviewer-a',
      'admin',
    ]);
    expect(new Set(data.accounts.map((entry) => entry.secret)).size).toBe(4);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    const second = await startIdentityProvider({ port: 0, redirectUris: [], credentialPath });
    await second.close();
    expect(await readFile(credentialPath, 'utf8')).toBe(content);
    await chmod(credentialPath, 0o644);
    await expect(
      startIdentityProvider({ port: 0, redirectUris: [], credentialPath }),
    ).rejects.toThrow('private regular file');
    await chmod(credentialPath, 0o600);
    const link = join(directory, 'linked.json');
    await symlink(credentialPath, link);
    await expect(
      startIdentityProvider({ port: 0, redirectUris: [], credentialPath: link }),
    ).rejects.toThrow();
    await writeFile(credentialPath, '{"private": "do-not-leak', { mode: 0o600 });
    await expect(
      startIdentityProvider({ port: 0, redirectUris: [], credentialPath }),
    ).rejects.toThrow('Invalid local SSO credential format');
  });
});
