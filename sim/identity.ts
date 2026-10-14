import Fastify from 'fastify';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const LOCAL_SSO_CLIENT_ID = 'verified-ui-capabilities';
export const LOCAL_SSO_USERS = ['operator-a', 'operator-b', 'reviewer-a', 'admin'] as const;
export interface IdentityAccount {
  subject: string;
  secret: string;
}
export interface IdentityOptions {
  port?: number;
  redirectUris: string[];
  credentialPath?: string;
  accounts?: IdentityAccount[];
}

const random = (): string => randomBytes(32).toString('base64url');
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const equal = (left: string, right: string): boolean =>
  timingSafeEqual(digest(left), digest(right));
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function validateAccounts(value: unknown): IdentityAccount[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32)
    throw new Error('Invalid local SSO account configuration');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object')
      throw new Error('Invalid local SSO account configuration');
    const { subject, secret } = item as Record<string, unknown>;
    if (
      typeof subject !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(subject) ||
      seen.has(subject) ||
      typeof secret !== 'string' ||
      secret.length < 32 ||
      secret.length > 256
    )
      throw new Error('Invalid local SSO account configuration');
    seen.add(subject);
    return { subject, secret };
  });
}

async function readAccounts(path: string): Promise<IdentityAccount[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 32_768 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('Local SSO credentials must be a private regular file');
    let data: { version?: unknown; accounts?: unknown };
    try {
      data = JSON.parse(await file.readFile('utf8')) as typeof data;
    } catch {
      throw new Error('Invalid local SSO credential format');
    }
    if (data.version !== 1) throw new Error('Invalid local SSO credential format');
    return validateAccounts(data.accounts);
  } finally {
    await file.close();
  }
}

async function loadAccounts(path: string): Promise<IdentityAccount[]> {
  try {
    return await readAccounts(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const accounts = LOCAL_SSO_USERS.map((subject) => ({ subject, secret: random() }));
  let file;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readAccounts(path);
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify({ version: 1, accounts }, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  return accounts;
}

interface Transaction {
  csrf: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  expires: number;
}
interface Code extends Omit<Transaction, 'csrf'> {
  subject: string;
  authTime: number;
}

function formFields(raw: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of new URLSearchParams(raw)) {
    if (Object.hasOwn(result, key)) throw new Error('Duplicate form field');
    result[key] = value;
  }
  return result;
}

function loginPage(csrf: string, message = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local SSO</title><style>
  :root{color-scheme:dark}body{font:16px/1.5 system-ui;background:#101521;color:#edf1fa;margin:0;padding:48px 20px}main{max-width:420px;margin:auto}h1{font-size:25px}p{color:#aebad0}label{display:grid;gap:6px;margin:18px 0}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #546078}input{background:#192335;color:inherit}button{width:100%;background:#afcaff;color:#101521;cursor:pointer}.error{color:#ffc3bd}
  </style></head><body><main><h1>Sign in to the local simulator</h1><p>Use your local SSO account. This identity provider is for development and testing.</p>${message ? `<p role="alert" class="error">${escape(message)}</p>` : ''}<form method="post" action="/login"><input type="hidden" name="csrf" value="${escape(csrf)}"><label>User<input name="username" autocomplete="username" required maxlength="64"></label><label>Password<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><button type="submit">Sign in</button></form></main></body></html>`;
}

/** Local protocol simulator, not a production identity provider. */
export async function startIdentityProvider(options: IdentityOptions) {
  const redirects = new Set<string>();
  const registerRedirectUri = (uri: string): void => {
    const url = new URL(uri);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== '/auth/callback' ||
      url.href !== uri
    )
      throw new Error('Local SSO callbacks must be exact loopback HTTP URLs');
    if (!redirects.has(uri) && redirects.size >= 16)
      throw new Error('Too many local SSO callbacks');
    redirects.add(uri);
  };
  options.redirectUris.forEach(registerRedirectUri);
  const configured = options.accounts
    ? validateAccounts(options.accounts)
    : await loadAccounts(options.credentialPath ?? '.runs/sso-users.json');
  const accounts = new Map(configured.map(({ subject, secret }) => [subject, digest(secret)]));
  const missingAccount = randomBytes(32);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const keyId = random();
  const jwk = { ...(await exportJWK(publicKey)), kid: keyId, use: 'sig', alg: 'RS256' };
  const transactions = new Map<string, Transaction>();
  const codes = new Map<string, Code>();
  const loginFailures = new Map<string, { count: number; expires: number }>();
  let requests = { count: 0, expires: Date.now() + 60_000 };
  let issuer = '';
  let cookieName = '';
  const app = Fastify({ logger: false, bodyLimit: 8192, requestTimeout: 10_000 });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, formFields(body as string));
      } catch {
        done(new Error('Invalid form'));
      }
    },
  );
  const prune = (): void => {
    const now = Date.now();
    for (const [id, value] of transactions) if (value.expires <= now) transactions.delete(id);
    for (const [id, value] of codes) if (value.expires <= now) codes.delete(id);
    for (const [id, value] of loginFailures) if (value.expires <= now) loginFailures.delete(id);
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'cache-control': 'no-store',
      // Keep the form's Origin header while withholding authorization query values.
      'referrer-policy': 'strict-origin',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${[...new Set([...redirects].map((uri) => new URL(uri).origin))].join(' ')}; frame-ancestors 'none'; base-uri 'none'`,
    });
    if (
      request.headers.host !== new URL(issuer).host ||
      (request.headers.origin !== undefined && request.headers.origin !== issuer)
    )
      return reply.code(403).send({ error: 'forbidden' });
    if (
      request.method === 'POST' &&
      new URL(request.url, issuer).pathname === '/login' &&
      (request.headers.origin !== issuer || request.headers['sec-fetch-site'] === 'cross-site')
    )
      return reply.code(403).send({ error: 'forbidden' });
    prune();
    if (Date.now() >= requests.expires) requests = { count: 0, expires: Date.now() + 60_000 };
    if (++requests.count > 300)
      return reply.code(429).header('retry-after', '60').send({ error: 'rate_limited' });
  });
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(400).send({ error: 'invalid_request' }),
  );
  app.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    scopes_supported: ['openid'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  }));
  app.get('/jwks', async () => ({ keys: [jwk] }));
  app.get('/authorize', async (request, reply) => {
    let query: Record<string, string>;
    try {
      query = formFields(new URL(request.url, issuer).search.slice(1));
    } catch {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (
      query.client_id !== LOCAL_SSO_CLIENT_ID ||
      query.response_type !== 'code' ||
      query.scope !== 'openid' ||
      (query.response_mode !== undefined && query.response_mode !== 'query') ||
      !query.redirect_uri ||
      !redirects.has(query.redirect_uri) ||
      !query.state ||
      query.state.length < 16 ||
      query.state.length > 512 ||
      !query.nonce ||
      query.nonce.length < 16 ||
      query.nonce.length > 512 ||
      query.code_challenge_method !== 'S256' ||
      !query.code_challenge ||
      !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)
    )
      return reply.code(400).send({ error: 'invalid_request' });
    if (transactions.size >= 256 || codes.size >= 256)
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    const id = random();
    const csrf = random();
    transactions.set(id, {
      csrf,
      redirectUri: query.redirect_uri,
      state: query.state,
      nonce: query.nonce,
      challenge: query.code_challenge,
      expires: Date.now() + 5 * 60_000,
    });
    reply.header(
      'set-cookie',
      `${cookieName}=${id}; HttpOnly; SameSite=Lax; Path=/login; Max-Age=300`,
    );
    return reply.type('text/html').send(loginPage(csrf));
  });
  app.post('/login', async (request, reply) => {
    const body = request.body as Record<string, string> | undefined;
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded') || !body)
      return reply.code(400).send({ error: 'invalid_request' });
    const cookies = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`));
    const id = cookies.length === 1 ? cookies[0]!.slice(cookieName.length + 1) : '';
    const transaction = transactions.get(id);
    if (!transaction || typeof body.csrf !== 'string' || !equal(transaction.csrf, body.csrf))
      return reply.code(403).send({ error: 'invalid_transaction' });
    const username =
      typeof body.username === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(body.username)
        ? body.username
        : '';
    const password =
      typeof body.password === 'string' && body.password.length <= 256 ? body.password : '';
    // Bucket unknown names together so arbitrary names cannot grow this map.
    const bucket = accounts.has(username) ? username : 'unknown';
    const failure = loginFailures.get(bucket);
    if (failure && failure.count >= 5)
      return reply.code(429).header('retry-after', '300').send({ error: 'rate_limited' });
    const valid = timingSafeEqual(accounts.get(username) ?? missingAccount, digest(password));
    if (!valid || !accounts.has(username)) {
      loginFailures.set(bucket, {
        count: (failure?.count ?? 0) + 1,
        expires: failure?.expires ?? Date.now() + 300_000,
      });
      return reply
        .code(401)
        .type('text/html')
        .send(loginPage(transaction.csrf, 'Sign-in failed. Check your user and password.'));
    }
    loginFailures.delete(bucket);
    transactions.delete(id);
    if (codes.size >= 256) return reply.code(503).send({ error: 'temporarily_unavailable' });
    const code = random();
    const { csrf: _csrf, ...details } = transaction;
    codes.set(code, {
      ...details,
      subject: username,
      authTime: Math.floor(Date.now() / 1000),
      expires: Date.now() + 60_000,
    });
    const destination = new URL(transaction.redirectUri);
    destination.searchParams.set('code', code);
    destination.searchParams.set('state', transaction.state);
    destination.searchParams.set('iss', issuer);
    reply.header('set-cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/login; Max-Age=0`);
    return reply.code(303).header('location', destination.href).send();
  });
  app.post('/token', async (request, reply) => {
    const body = request.body as Record<string, string> | undefined;
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded') || !body)
      return reply.code(400).send({ error: 'invalid_request' });
    const code = typeof body.code === 'string' ? codes.get(body.code) : undefined;
    if (typeof body.code === 'string') codes.delete(body.code);
    if (
      !code ||
      body.grant_type !== 'authorization_code' ||
      body.client_id !== LOCAL_SSO_CLIENT_ID ||
      body.redirect_uri !== code.redirectUri ||
      typeof body.code_verifier !== 'string' ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) ||
      !equal(digest(body.code_verifier).toString('base64url'), code.challenge)
    )
      return reply.code(400).send({ error: 'invalid_grant' });
    const idToken = await new SignJWT({ nonce: code.nonce, auth_time: code.authTime })
      .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(LOCAL_SSO_CLIENT_ID)
      .setSubject(code.subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return { id_token: idToken, access_token: random(), token_type: 'Bearer', expires_in: 300 };
  });
  try {
    issuer = await app.listen({ host: '127.0.0.1', port: options.port ?? 4104 });
    cookieName = `local_sso_${new URL(issuer).port}`;
    return {
      issuer,
      registerRedirectUri,
      close: async (): Promise<void> => {
        await app.close();
        transactions.clear();
        codes.clear();
        loginFailures.clear();
        accounts.clear();
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const provider = await startIdentityProvider({
    redirectUris: ['http://127.0.0.1:4100/auth/callback'],
  });
  console.log(
    `Local SSO: ${provider.issuer}\nCredentials: .runs/sso-users.json (private local file)`,
  );
  const close = async (): Promise<void> => {
    await provider.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
