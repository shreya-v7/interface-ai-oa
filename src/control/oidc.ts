import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';

export const OIDC_TRANSACTION_MS = 5 * 60_000;
const MAX_TRANSACTIONS = 100;
const MAX_JSON_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const KEY_CACHE_MS = 5 * 60_000;
const KEY_REFRESH_MS = 30_000;

interface OidcOptions {
  issuer: string;
  clientId: string;
  allowInsecureLoopback?: boolean;
  now?: () => number;
}

interface Transaction {
  cookieDigest: Buffer;
  verifier: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
}

function rejected(): Error {
  // Provider responses and tokens can contain secrets. Never propagate their errors.
  return new Error('OIDC_REJECTED');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function checkedUrl(value: unknown, allowInsecureLoopback: boolean): URL {
  if (typeof value !== 'string' || value.length > 2048) throw rejected();
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(allowInsecureLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  )
    throw rejected();
  return url;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw rejected();
  return value as Record<string, unknown>;
}

function includes(value: unknown, expected: string): boolean {
  return (
    Array.isArray(value) && value.every((v) => typeof v === 'string') && value.includes(expected)
  );
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json', ...init.headers },
  });
  if (
    !response.ok ||
    !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
    Number(response.headers.get('content-length') ?? 0) > MAX_JSON_BYTES ||
    !response.body
  ) {
    await response.body?.cancel();
    throw rejected();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw rejected();
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    await reader.cancel();
  }
}

/** Public-client OIDC code flow. Identity comes only from a verified ID token. */
export class OidcClient {
  private readonly transactions = new Map<string, Transaction>();
  private keys?: ReturnType<typeof createLocalJWKSet>;
  private keysLoadedAt = Number.NEGATIVE_INFINITY;
  private refreshing?: Promise<void>;
  private readonly now: () => number;

  private constructor(
    private readonly options: OidcOptions,
    private readonly authorizationEndpoint: string,
    private readonly tokenEndpoint: string,
    private readonly jwksUri: string,
  ) {
    this.now = options.now ?? Date.now;
  }

  static async create(options: OidcOptions): Promise<OidcClient> {
    try {
      const issuer = checkedUrl(options.issuer, options.allowInsecureLoopback === true);
      if (!options.clientId || options.clientId.length > 256 || /\s/.test(options.clientId))
        throw rejected();
      const metadata = await fetchJson(
        `${options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      );
      if (
        metadata.issuer !== options.issuer ||
        !includes(metadata.response_types_supported, 'code') ||
        !includes(metadata.id_token_signing_alg_values_supported, 'RS256') ||
        !includes(metadata.code_challenge_methods_supported, 'S256') ||
        !includes(metadata.token_endpoint_auth_methods_supported, 'none') ||
        (metadata.grant_types_supported !== undefined &&
          !includes(metadata.grant_types_supported, 'authorization_code'))
      )
        throw rejected();
      const endpoint = (value: unknown): string => {
        const url = checkedUrl(value, options.allowInsecureLoopback === true);
        // Intentionally narrower than general OIDC discovery: metadata cannot redirect
        // server requests to a second host or a different port.
        if (url.origin !== issuer.origin) throw rejected();
        return url.href;
      };
      const client = new OidcClient(
        { ...options },
        endpoint(metadata.authorization_endpoint),
        endpoint(metadata.token_endpoint),
        endpoint(metadata.jwks_uri),
      );
      await client.refreshKeys();
      return client;
    } catch {
      throw rejected();
    }
  }

  begin(redirectUri: string): { authorizationUrl: string; cookie: string } {
    try {
      checkedUrl(redirectUri, this.options.allowInsecureLoopback === true);
      for (const [state, transaction] of this.transactions) {
        if (transaction.expiresAt <= this.now()) this.transactions.delete(state);
      }
      if (this.transactions.size >= MAX_TRANSACTIONS) throw rejected();
      const state = randomBytes(32).toString('hex');
      const nonce = randomBytes(32).toString('hex');
      const cookie = randomBytes(32).toString('hex');
      const verifier = randomBytes(32).toString('base64url');
      this.transactions.set(state, {
        cookieDigest: digest(cookie),
        nonce,
        verifier,
        redirectUri,
        expiresAt: this.now() + OIDC_TRANSACTION_MS,
      });
      const url = new URL(this.authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: this.options.clientId,
        response_type: 'code',
        response_mode: 'query',
        scope: 'openid',
        redirect_uri: redirectUri,
        state,
        nonce,
        code_challenge: digest(verifier).toString('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return { authorizationUrl: url.href, cookie };
    } catch {
      throw rejected();
    }
  }

  async complete(input: {
    code: string;
    state: string;
    cookie: string;
    redirectUri: string;
  }): Promise<{ subject: string; issuer: string }> {
    try {
      const transaction = this.transactions.get(input.state);
      // Consume before any network request so concurrent callbacks cannot both pass.
      this.transactions.delete(input.state);
      if (
        !transaction ||
        transaction.expiresAt <= this.now() ||
        input.redirectUri !== transaction.redirectUri ||
        typeof input.cookie !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.cookie) ||
        !timingSafeEqual(digest(input.cookie), transaction.cookieDigest) ||
        typeof input.code !== 'string' ||
        !input.code ||
        input.code.length > 4096 ||
        /[\u0000-\u0020\u007f]/.test(input.code)
      )
        throw rejected();
      const token = await fetchJson(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.options.clientId,
          code: input.code,
          redirect_uri: transaction.redirectUri,
          code_verifier: transaction.verifier,
        }),
      });
      if (typeof token.id_token !== 'string' || token.id_token.length > 16384) throw rejected();
      const header = decodeProtectedHeader(token.id_token);
      if (header.alg !== 'RS256' || header.jku || header.jwk || header.x5u) throw rejected();
      if (this.now() - this.keysLoadedAt >= KEY_CACHE_MS) await this.refreshKeys();
      const verify = () =>
        jwtVerify(token.id_token as string, this.keys!, {
          algorithms: ['RS256'],
          issuer: this.options.issuer,
          audience: this.options.clientId,
          requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
          currentDate: new Date(this.now()),
          maxTokenAge: '5 minutes',
        });
      let verified;
      try {
        verified = await verify();
      } catch (error) {
        if (
          (error as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY' ||
          this.now() - this.keysLoadedAt < KEY_REFRESH_MS
        )
          throw error;
        await this.refreshKeys();
        verified = await verify();
      }
      const claims = verified.payload;
      if (
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        claims.sub.length > 255 ||
        /[^\x21-\x7e]/.test(claims.sub) ||
        claims.nonce !== transaction.nonce ||
        !Number.isSafeInteger(claims.iat) ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp! <= claims.iat! ||
        (claims.azp !== undefined && claims.azp !== this.options.clientId) ||
        (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.options.clientId)
      )
        throw rejected();
      return { subject: claims.sub, issuer: this.options.issuer };
    } catch {
      throw rejected();
    }
  }

  private async refreshKeys(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const keySet = await fetchJson(this.jwksUri);
      if (!Array.isArray(keySet.keys) || !keySet.keys.length || keySet.keys.length > 16)
        throw rejected();
      for (const value of keySet.keys) {
        const key = record(value);
        if (
          key.kty !== 'RSA' ||
          typeof key.n !== 'string' ||
          Buffer.from(key.n, 'base64url').length < 256 ||
          typeof key.e !== 'string' ||
          (key.alg !== undefined && key.alg !== 'RS256') ||
          (key.use !== undefined && key.use !== 'sig') ||
          'd' in key
        )
          throw rejected();
      }
      this.keys = createLocalJWKSet(keySet as unknown as JSONWebKeySet);
      this.keysLoadedAt = this.now();
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
}
