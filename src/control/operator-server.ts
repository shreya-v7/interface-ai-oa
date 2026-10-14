import Fastify from 'fastify';
import {
  expiredLegacySessionCookie,
  initializeOperatorCredential,
  OperatorAuth,
  sessionCookie,
} from './auth.js';
import { operatorPage } from './operator-page.js';
import { AccessPolicy, can, loadAccessPolicy, type Principal } from './access.js';
import { OidcClient, OIDC_TRANSACTION_MS } from './oidc.js';

export interface OperatorRunSummary {
  runId: string;
  capability: string;
  tenant: string;
  state: string;
  epoch: number;
  owner: string;
  reason?: string;
  stepId?: string;
}
export type OperatorCommand = 'takeover' | 'resume' | 'abort' | 'resolve';
export interface OperatorManager {
  list(): OperatorRunSummary[] | Promise<OperatorRunSummary[]>;
  control(
    runId: string,
    command: OperatorCommand,
    expectedEpoch: number,
    principal: Principal,
  ): Promise<void>;
}
const FLOW_COOKIE = 'capability_oidc_flow';
function flowCookie(value: string, clear = false): string {
  return `${FLOW_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=${clear ? 0 : OIDC_TRANSACTION_MS / 1000}`;
}
function flowSecret(cookies: string | undefined): string {
  const matches = (cookies ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${FLOW_COOKIE}=`));
  return matches.length === 1 ? matches[0]!.slice(FLOW_COOKIE.length + 1) : '';
}
/** Bind to loopback. OIDC and local-key modes are exclusive; failed SSO never downgrades. */
export async function startOperatorServer(options: {
  manager: OperatorManager;
  port?: number;
  token?: string;
  now?: () => number;
  access?: AccessPolicy;
  keyPrincipalId?: string;
  oidc?: OidcClient;
}) {
  const app = Fastify({ logger: false, bodyLimit: 8192 });
  const access = options.access ?? (await loadAccessPolicy());
  const keyPrincipal = options.oidc
    ? undefined
    : access.principal(options.keyPrincipalId ?? 'local_operator', 'human');
  const auth = new OperatorAuth(
    options.oidc ? undefined : (options.token ?? (await initializeOperatorCredential()).token),
    options.now,
  );
  let origin = '';
  const subscribers = new Map<
    import('node:http').ServerResponse,
    { session: string; previous: string }
  >();
  const sessionFor = (cookie: string | undefined) => {
    const session = auth.authenticate(cookie);
    const principal = session ? auth.principal(session) : undefined;
    return session && principal ? { session, principal } : undefined;
  };
  const projection = (runs: OperatorRunSummary[], principal: Principal) => ({
    principal: { id: principal.id, grants: principal.grants },
    runs: runs
      .filter((run) => can(principal, run.tenant, 'read'))
      .map((run) => ({
        ...run,
        actions: [
          ...(can(principal, run.tenant, 'control') ? ['takeover', 'resume', 'abort'] : []),
          ...(can(principal, run.tenant, 'resolve') ? ['resolve'] : []),
        ],
      })),
  });
  const pruneSubscribers = () => {
    for (const [response, subscriber] of subscribers) {
      if (!auth.active(subscriber.session)) {
        subscribers.delete(response);
        response.end();
      }
    }
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const callback =
      options.oidc && request.method === 'GET' && request.url.split('?')[0] === '/auth/callback';
    if (
      request.headers.host !== new URL(origin).host ||
      (!callback && request.headers['sec-fetch-site'] === 'cross-site')
    )
      return reply.code(403).send({ error: 'ORIGIN_REJECTED' });
    if (!callback && request.headers.origin && request.headers.origin !== origin)
      return reply.code(403).send({ error: 'ORIGIN_REJECTED' });
    if (request.url.startsWith('/api/')) {
      if (request.method !== 'GET' && request.headers.origin !== origin)
        return reply.code(403).send({ error: 'ORIGIN_REQUIRED' });
      if (request.url !== '/api/login' && !sessionFor(request.headers.cookie))
        return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    }
  });
  app.get('/', async (_request, reply) =>
    reply.type('text/html').send(operatorPage(Boolean(options.oidc))),
  );
  app.get('/auth/login', async (request, reply) => {
    if (!options.oidc) return reply.code(404).send({ error: 'SSO_NOT_CONFIGURED' });
    const previous = auth.authenticate(request.headers.cookie);
    if (previous) auth.revoke(previous);
    pruneSubscribers();
    reply.header('Set-Cookie', [sessionCookie('', true), expiredLegacySessionCookie]);
    try {
      const flow = options.oidc.begin(`${origin}/auth/callback`);
      reply.header('Set-Cookie', [
        flowCookie(flow.cookie),
        sessionCookie('', true),
        expiredLegacySessionCookie,
      ]);
      return reply.redirect(flow.authorizationUrl);
    } catch {
      return reply.code(400).send({ error: 'OIDC_REJECTED' });
    }
  });
  app.get<{ Querystring: { code?: unknown; state?: unknown } }>(
    '/auth/callback',
    async (request, reply) => {
      if (!options.oidc) return reply.code(404).send({ error: 'SSO_NOT_CONFIGURED' });
      reply.header('Set-Cookie', flowCookie('', true));
      try {
        if (typeof request.query.code !== 'string' || typeof request.query.state !== 'string')
          throw new Error('OIDC_REJECTED');
        const identity = await options.oidc.complete({
          code: request.query.code,
          state: request.query.state,
          cookie: flowSecret(request.headers.cookie),
          redirectUri: `${origin}/auth/callback`,
        });
        const principal = access.forSubject(identity.subject);
        const result = auth.issue(principal);
        reply.header('Set-Cookie', [
          flowCookie('', true),
          sessionCookie(result.session),
          expiredLegacySessionCookie,
        ]);
        return reply.redirect('/');
      } catch {
        return reply.code(400).send({ error: 'OIDC_REJECTED' });
      }
    },
  );
  app.post<{ Body: { token?: unknown } }>('/api/login', async (request, reply) => {
    if (!keyPrincipal) return reply.code(403).send({ error: 'LOCAL_LOGIN_DISABLED' });
    const result = auth.login(request.body?.token, keyPrincipal);
    if ('error' in result) {
      if (result.error === 'LOGIN_RATE_LIMITED') reply.header('Retry-After', '60');
      return reply.code(result.error === 'LOGIN_RATE_LIMITED' ? 429 : 401).send(result);
    }
    const previous = auth.authenticate(request.headers.cookie);
    if (previous) auth.revoke(previous);
    pruneSubscribers();
    reply.header('Set-Cookie', [sessionCookie(result.session), expiredLegacySessionCookie]);
    return { authenticated: true };
  });
  app.post('/api/logout', async (request, reply) => {
    const session = auth.authenticate(request.headers.cookie);
    if (session) auth.revoke(session);
    pruneSubscribers();
    reply.header('Set-Cookie', [sessionCookie('', true), expiredLegacySessionCookie]);
    return { authenticated: false };
  });
  app.get('/api/runs', async (request, reply) => {
    const runs = await options.manager.list();
    const current = sessionFor(request.headers.cookie);
    if (!current) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    return projection(runs, current.principal);
  });
  app.get('/api/events', async (request, reply) => {
    const runs = await options.manager.list();
    const current = sessionFor(request.headers.cookie);
    if (!current) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const data = JSON.stringify(projection(runs, current.principal));
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    subscribers.set(reply.raw, { session: current.session, previous: data });
    reply.raw.write(`data: ${data}\n\n`);
    reply.raw.on('close', () => subscribers.delete(reply.raw));
  });
  app.post<{ Params: { runId: string; command: string }; Body: { expectedEpoch?: unknown } }>(
    '/api/runs/:runId/:command',
    async (request, reply) => {
      const { runId, command } = request.params;
      if (
        !['takeover', 'resume', 'abort', 'resolve'].includes(command) ||
        !Number.isSafeInteger(request.body?.expectedEpoch) ||
        (request.body.expectedEpoch as number) < 0
      )
        return reply.code(400).send({ error: 'INVALID_COMMAND' });
      const runs = await options.manager.list();
      const current = sessionFor(request.headers.cookie);
      if (!current) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      const run = runs.find((entry) => entry.runId === runId);
      if (!run || !can(current.principal, run.tenant, 'read'))
        return reply.code(404).send({ error: 'RUN_NOT_FOUND' });
      if (!can(current.principal, run.tenant, command === 'resolve' ? 'resolve' : 'control'))
        return reply.code(403).send({ error: 'ACCESS_DENIED' });
      try {
        await options.manager.control(
          runId,
          command as OperatorCommand,
          request.body.expectedEpoch as number,
          current.principal,
        );
        return { accepted: true };
      } catch {
        return reply.code(409).send({
          error: 'CONTROL_REJECTED',
          message:
            'The session changed or cannot accept this command. Refresh its state and try again.',
        });
      }
    },
  );
  const address = await app.listen({ port: options.port ?? 4100, host: '127.0.0.1' });
  origin = address;
  const timer = setInterval(() => {
    pruneSubscribers();
    if (!subscribers.size) return;
    void Promise.resolve()
      .then(() => options.manager.list())
      .then((runs) => {
        pruneSubscribers();
        for (const [response, subscriber] of subscribers) {
          const principal = auth.principal(subscriber.session);
          if (!principal) continue;
          const data = JSON.stringify(projection(runs, principal));
          if (data === subscriber.previous) continue;
          subscriber.previous = data;
          response.write(`data: ${data}\n\n`);
        }
      })
      .catch(() => undefined);
  }, 350);
  timer.unref();
  return {
    url: origin,
    async close() {
      clearInterval(timer);
      auth.clear();
      for (const response of subscribers.keys()) response.end();
      subscribers.clear();
      await app.close();
    },
  };
}
