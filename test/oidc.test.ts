import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OidcClient, OIDC_TRANSACTION_MS } from '../src/control/oidc.js';

describe('OIDC code flow', () => {
  let server: Server;
  let issuer: string;
  let pair: Awaited<ReturnType<typeof generateKeyPair>>;
  let publicKey: Awaited<ReturnType<typeof exportJWK>>;
  let otherPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let clock: number;
  let metadataOverride: Record<string, unknown>;
  let claimsOverride: JWTPayload;
  let omitClaims: string[];
  let activeAuthorization: URL;
  let wrongSignature: boolean;
  let redirectPath: string | undefined;
  let tokenCalls: number;
  let keyCalls: number;
  let escapedCalls: number;
  let lastTokenBody: URLSearchParams;
  const clientId = 'verified-ui-capabilities';
  const callback = 'http://127.0.0.1:4100/auth/callback';

  beforeAll(async () => {
    pair = await generateKeyPair('RS256', { extractable: true });
    otherPair = await generateKeyPair('RS256');
    publicKey = { ...(await exportJWK(pair.publicKey)), use: 'sig', alg: 'RS256', kid: 'key-1' };
    server = createServer(async (request, response) => {
      try {
        const path = new URL(request.url!, issuer).pathname;
        if (path === redirectPath) {
          response.writeHead(302, { Location: `${issuer}/escaped` }).end();
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        if (path === '/.well-known/openid-configuration') {
          response.end(
            JSON.stringify({
              issuer,
              authorization_endpoint: `${issuer}/authorize`,
              token_endpoint: `${issuer}/token`,
              jwks_uri: `${issuer}/keys`,
              response_types_supported: ['code'],
              grant_types_supported: ['authorization_code'],
              id_token_signing_alg_values_supported: ['RS256'],
              code_challenge_methods_supported: ['S256'],
              token_endpoint_auth_methods_supported: ['none'],
              ...metadataOverride,
            }),
          );
        } else if (path === '/keys') {
          keyCalls++;
          response.end(JSON.stringify({ keys: [publicKey] }));
        } else if (path === '/token') {
          tokenCalls++;
          const parts: Buffer[] = [];
          for await (const chunk of request) parts.push(chunk as Buffer);
          lastTokenBody = new URLSearchParams(Buffer.concat(parts).toString());
          const challenge = createHash('sha256')
            .update(lastTokenBody.get('code_verifier') ?? '')
            .digest('base64url');
          if (challenge !== activeAuthorization.searchParams.get('code_challenge')) {
            response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          const now = Math.floor(clock / 1000);
          const claims: JWTPayload = {
            iss: issuer,
            aud: clientId,
            sub: 'operator-a',
            iat: now,
            exp: now + 120,
            nonce: activeAuthorization.searchParams.get('nonce'),
            ...claimsOverride,
          };
          for (const key of omitClaims) delete claims[key];
          const token = await new SignJWT(claims)
            .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
            .sign(wrongSignature ? otherPair.privateKey : pair.privateKey);
          response.end(JSON.stringify({ id_token: token, access_token: 'unused-secret' }));
        } else {
          escapedCalls++;
          response.writeHead(404).end('{}');
        }
      } catch {
        response.writeHead(500).end('{}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test address');
    issuer = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    clock = Date.UTC(2026, 9, 13, 12);
    metadataOverride = {};
    claimsOverride = {};
    omitClaims = [];
    wrongSignature = false;
    redirectPath = undefined;
    tokenCalls = 0;
    keyCalls = 0;
    escapedCalls = 0;
  });

  const client = () =>
    OidcClient.create({ issuer, clientId, allowInsecureLoopback: true, now: () => clock });

  function begin(oidc: OidcClient) {
    const start = oidc.begin(callback);
    activeAuthorization = new URL(start.authorizationUrl);
    return {
      code: 'one-time-code',
      state: activeAuthorization.searchParams.get('state')!,
      cookie: start.cookie,
      redirectUri: callback,
    };
  }

  it('binds code exchange to the browser, PKCE verifier, nonce and exact callback', async () => {
    const oidc = await client();
    const transaction = begin(oidc);
    expect(activeAuthorization.searchParams.get('response_type')).toBe('code');
    expect(activeAuthorization.searchParams.get('scope')).toBe('openid');
    expect(activeAuthorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(activeAuthorization.searchParams.has('code_verifier')).toBe(false);
    expect(activeAuthorization.href).not.toContain(transaction.cookie);
    await expect(oidc.complete(transaction)).resolves.toEqual({ subject: 'operator-a', issuer });
    expect(lastTokenBody.get('client_id')).toBe(clientId);
    expect(lastTokenBody.get('redirect_uri')).toBe(callback);
    expect(lastTokenBody.get('grant_type')).toBe('authorization_code');
    expect(lastTokenBody.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keyCalls).toBe(1);
    await expect(oidc.complete(transaction)).rejects.toThrow(/^OIDC_REJECTED$/);
    expect(tokenCalls).toBe(1);
  });

  it('accepts only one of two concurrent callbacks', async () => {
    const oidc = await client();
    const transaction = begin(oidc);
    const results = await Promise.allSettled([
      oidc.complete(transaction),
      oidc.complete(transaction),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(tokenCalls).toBe(1);
  });

  it.each(['cookie', 'state', 'redirectUri'] as const)(
    'rejects a changed %s without exchanging the code',
    async (field) => {
      const oidc = await client();
      const transaction = begin(oidc);
      await expect(oidc.complete({ ...transaction, [field]: 'attacker-value' })).rejects.toThrow(
        /^OIDC_REJECTED$/,
      );
      expect(tokenCalls).toBe(0);
      if (field !== 'state')
        await expect(oidc.complete(transaction)).rejects.toThrow(/^OIDC_REJECTED$/);
    },
  );

  it('expires transactions and bounds pending attempts', async () => {
    const oidc = await client();
    const expired = begin(oidc);
    clock += OIDC_TRANSACTION_MS;
    await expect(oidc.complete(expired)).rejects.toThrow(/^OIDC_REJECTED$/);
    expect(tokenCalls).toBe(0);
    for (let i = 0; i < 100; i++) oidc.begin(callback);
    expect(() => oidc.begin(callback)).toThrow(/^OIDC_REJECTED$/);
    clock += OIDC_TRANSACTION_MS;
    expect(() => oidc.begin(callback)).not.toThrow();
  });

  it.each([
    ['issuer', { iss: 'https://attacker.invalid' }],
    ['audience', { aud: 'another-client' }],
    ['nonce', { nonce: 'substituted-nonce' }],
    ['authorized party', { azp: 'another-client' }],
    ['multiple audiences without authorized party', { aud: [clientId, 'another-client'] }],
    ['empty subject', { sub: '' }],
    ['expired token', { exp: Math.floor(Date.UTC(2026, 9, 13, 12) / 1000) - 1 }],
    ['future token', { iat: Math.floor(Date.UTC(2026, 9, 13, 12) / 1000) + 60 }],
    ['stale token', { iat: Math.floor(Date.UTC(2026, 9, 13, 12) / 1000) - 301 }],
  ] as const)('rejects an invalid %s', async (_label, overrides) => {
    const oidc = await client();
    const transaction = begin(oidc);
    claimsOverride = overrides as JWTPayload;
    await expect(oidc.complete(transaction)).rejects.toThrow(/^OIDC_REJECTED$/);
  });

  it.each(['sub', 'iat', 'exp', 'nonce'])('rejects missing required %s', async (claim) => {
    const oidc = await client();
    const transaction = begin(oidc);
    omitClaims = [claim];
    await expect(oidc.complete(transaction)).rejects.toThrow(/^OIDC_REJECTED$/);
  });

  it('rejects a forged signature and ignores token role claims', async () => {
    const oidc = await client();
    const transaction = begin(oidc);
    wrongSignature = true;
    await expect(oidc.complete(transaction)).rejects.toThrow(/^OIDC_REJECTED$/);
    wrongSignature = false;
    claimsOverride = { role: 'admin', tenants: ['*'], aud: [clientId, 'other'], azp: clientId };
    await expect(oidc.complete(begin(oidc))).resolves.toEqual({ subject: 'operator-a', issuer });
  });

  it.each([
    { issuer: 'https://different.invalid' },
    { token_endpoint: 'https://different.invalid/token' },
    { jwks_uri: 'http://169.254.169.254/latest/meta-data/' },
    { authorization_endpoint: 'https://different.invalid/auth' },
    { code_challenge_methods_supported: ['plain'] },
    { response_types_supported: ['token'] },
    { token_endpoint_auth_methods_supported: ['client_secret_post'] },
  ])('rejects unsupported or unsafe discovery metadata %j', async (override) => {
    metadataOverride = override;
    await expect(client()).rejects.toThrow(/^OIDC_REJECTED$/);
    expect(escapedCalls).toBe(0);
    expect(keyCalls).toBe(0);
  });

  it('allows HTTP only for explicit loopback configuration', async () => {
    await expect(OidcClient.create({ issuer, clientId })).rejects.toThrow(/^OIDC_REJECTED$/);
    await expect(
      OidcClient.create({ issuer: 'http://localhost:4104', clientId, allowInsecureLoopback: true }),
    ).rejects.toThrow(/^OIDC_REJECTED$/);
    const oidc = await client();
    expect(() => oidc.begin('http://outside.invalid/callback')).toThrow(/^OIDC_REJECTED$/);
    expect(() => oidc.begin(`${callback}?injected=yes`)).toThrow(/^OIDC_REJECTED$/);
  });

  it.each(['/.well-known/openid-configuration', '/keys', '/token'])(
    'never follows a redirect from %s',
    async (path) => {
      if (path === '/token') {
        const oidc = await client();
        const transaction = begin(oidc);
        redirectPath = path;
        await expect(oidc.complete(transaction)).rejects.toThrow(/^OIDC_REJECTED$/);
      } else {
        redirectPath = path;
        await expect(client()).rejects.toThrow(/^OIDC_REJECTED$/);
      }
      expect(escapedCalls).toBe(0);
    },
  );
});
