import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { launchSurface } from '../src/surface/web.js';
import { makeProfiles } from '../vendor/legacy-core/profiles.js';

describe('adversarial browser network boundary', () => {
  it.each([301, 302, 303, 307, 308])(
    'blocks a %s redirect chain before its unlisted endpoint',
    async (status) => {
      const app = Fastify();
      let forbiddenRequests = 0;
      app.get('/core/members/search', (_request, reply) =>
        reply.code(status).redirect('/core/members/results'),
      );
      app.get('/core/members/results', (_request, reply) =>
        reply.code(status).redirect('/unlisted'),
      );
      app.get('/unlisted', () => {
        forbiddenRequests++;
        return 'unexpected request';
      });
      const origin = await app.listen({ port: 0, host: '127.0.0.1' });
      const live = await launchSurface({
        profile: makeProfiles({ a: origin, b: origin }).a,
        headless: true,
      });
      try {
        await live.surface
          .act(
            { type: 'navigate', route: { template: '/core/members/search', bindings: {} } },
            {},
            {},
          )
          .catch(() => {});
        expect(forbiddenRequests).toBe(0);
        expect(live.surface.network!.blocked).toBeGreaterThan(0);
        expect(live.surface.metrics.unsafeDispatch).toBe(1);
      } finally {
        await live.close();
        await app.close();
      }
    },
  );

  it('checks the preserved POST method before a 307 redirect to a read-only path', async () => {
    const app = Fastify();
    let forbiddenRequests = 0;
    app.get('/core', () => '<h1>Bank</h1>');
    app.post('/core/application/review', (_request, reply) =>
      reply.code(307).redirect('/core/members/search'),
    );
    app.post('/core/members/search', () => {
      forbiddenRequests++;
      return 'unexpected write';
    });
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const live = await launchSurface({
      profile: makeProfiles({ a: origin, b: origin }).a,
      headless: true,
    });
    try {
      await live.page.goto(`${origin}/core`);
      await live.page.evaluate(async () => {
        await fetch('/core/application/review', { method: 'POST' }).catch(() => {});
      });
      expect(forbiddenRequests).toBe(0);
      expect(live.surface.network!.blocked).toBe(1);
    } finally {
      await live.close();
      await app.close();
    }
  });

  it('blocks redirects from a nested frame to a different local origin', async () => {
    const destination = Fastify(),
      app = Fastify();
    let leakedRequests = 0;
    destination.get('/capture', () => {
      leakedRequests++;
      return 'unexpected';
    });
    const outside = await destination.listen({ port: 0, host: '127.0.0.1' });
    app.get('/core', (_request, reply) =>
      reply.type('text/html').send('<iframe src="/core/members/search"></iframe>'),
    );
    app.get('/core/members/search', (_request, reply) => reply.redirect(`${outside}/capture`));
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const live = await launchSurface({
      profile: makeProfiles({ a: origin, b: origin }).a,
      headless: true,
    });
    try {
      await live.page.goto(`${origin}/core`);
      expect(leakedRequests).toBe(0);
      expect(live.surface.network!.blocked).toBe(1);
    } finally {
      await live.close();
      await app.close();
      await destination.close();
    }
  });

  it('blocks direct, encoded, alternate-method and human-triggered requests to final creation', async () => {
    const app = Fastify();
    let forbiddenRequests = 0;
    app.get('/core/members/search', () => '<h1>Member search</h1>');
    app.all('*', () => {
      forbiddenRequests++;
      return 'unexpected request';
    });
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const live = await launchSurface({
      profile: makeProfiles({ a: origin, b: origin }).a,
      headless: true,
    });
    try {
      await live.page.goto(`${origin}/core/members/search`);
      await live.session.takeover('test_operator');
      for (const path of [
        '/core/application/commit',
        '/core/application/%63ommit',
        '/core/application/new/../commit',
      ])
        for (const method of ['GET', 'POST', 'PUT', 'DELETE'])
          await live.page.evaluate(
            async ({ path, method }) => {
              await fetch(path, { method }).catch(() => {});
            },
            { path, method },
          );
      expect(forbiddenRequests).toBe(0);
      expect(live.surface.network!.blocked).toBe(12);
    } finally {
      await live.close();
      await app.close();
    }
  });
});
