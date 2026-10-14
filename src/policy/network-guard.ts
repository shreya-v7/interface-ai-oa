import type { BrowserContext } from 'playwright';
import type { Profile } from '../schema/index.js';
import { allowedUrl } from './gate.js';
import { writeEvent } from './events.js';

export interface NetworkStats {
  blocked: number;
  popups: number;
  downloads: number;
  nativeDialogs: number;
}
const installed = new WeakMap<BrowserContext, { origin: string; ready: Promise<NetworkStats> }>();
export function installNetworkGuard(
  context: BrowserContext,
  profile: Profile,
  runId: string,
  journalPath?: string,
): Promise<NetworkStats> {
  const existing = installed.get(context);
  if (existing) {
    if (existing.origin !== profile.origin) throw new Error('CONTEXT_PROFILE_MISMATCH');
    return existing.ready;
  }
  const ready = (async () => {
    const stats: NetworkStats = { blocked: 0, popups: 0, downloads: 0, nativeDialogs: 0 };
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (!allowedUrl(request.url(), profile, request.method())) {
        stats.blocked++;
        await writeEvent(journalPath, {
          runId,
          type: 'network_block',
          code: 'REQUEST_BLOCKED',
          count: stats.blocked,
        });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket('**/*', async (socket) => {
      stats.blocked++;
      socket.close();
    });
    const pages = context.pages();
    const main = pages[0];
    const guardPage = async (page: import('playwright').Page) => {
      // Playwright routing sees only the first request in a redirect chain.
      // Chromium response interception checks every Location before it is followed,
      // including 307/308 redirects that preserve a POST body.
      const client = await context.newCDPSession(page);
      client.on('Fetch.requestPaused', (event) => {
        void (async () => {
          const status = event.responseStatusCode ?? 0;
          const location = event.responseHeaders?.find(
            (h) => h.name.toLowerCase() === 'location',
          )?.value;
          let blocked = false;
          if ([301, 302, 303, 307, 308].includes(status) && location) {
            const method =
              (status === 303 && event.request.method !== 'HEAD') ||
              ([301, 302].includes(status) && event.request.method === 'POST')
                ? 'GET'
                : event.request.method;
            try {
              blocked = !allowedUrl(new URL(location, event.request.url).href, profile, method);
            } catch {
              blocked = true;
            }
          }
          if (blocked) {
            stats.blocked++;
            await client.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            });
            await writeEvent(journalPath, {
              runId,
              type: 'network_block',
              code: 'REDIRECT_BLOCKED',
              count: stats.blocked,
            });
          } else await client.send('Fetch.continueRequest', { requestId: event.requestId });
        })().catch(() => {
          void page.close().catch(() => {});
        });
      });
      await client.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Response' }],
      });
      page.on('download', (download) => {
        stats.downloads++;
        void download.cancel();
      });
      page.on('dialog', (dialog) => {
        stats.nativeDialogs++;
        void dialog.dismiss();
        void writeEvent(journalPath, {
          runId,
          type: 'dialog_block',
          code: 'UNKNOWN_NATIVE_DIALOG',
        });
      });
    };
    for (const page of pages) await guardPage(page);
    context.on('page', (page) => {
      // The launch helper creates its initial page before installing this guard.
      if (page !== main) {
        stats.popups++;
        void page.close().catch(() => {});
      }
    });
    return stats;
  })();
  installed.set(context, { origin: profile.origin, ready });
  return ready;
}
