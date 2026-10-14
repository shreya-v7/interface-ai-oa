import { ReplayEngine } from '../../src/replay/engine.js';
import { initializeRuntime, registerEngine } from '../../src/registry.js';
import { launchSurface } from '../../src/surface/web.js';
import { createFixtureCapability } from '../../fixtures/capability.js';
import type { Profile, Inputs } from '../../src/schema/index.js';
import type { SessionTicket } from '../../sim/types.js';

interface Configuration {
  directory: string;
  runId: string;
  requestKey: string;
  profile: Profile;
  inputs: Inputs;
  cookie: SessionTicket['cookie'];
}

process.once('message', async (configuration: Configuration) => {
  try {
    const ledger = initializeRuntime(configuration.directory);
    const cap = createFixtureCapability();
    const live = await launchSurface({
      profile: configuration.profile,
      runId: configuration.runId,
      cookies: [configuration.cookie],
      headless: true,
    });
    const engine = new ReplayEngine(cap, configuration.inputs, configuration.profile, {
      page: live.page,
      session: live.session,
      runId: configuration.runId,
    });
    registerEngine(engine, cap.id, 'a', {
      requestKeyDigest: ledger.keyFingerprint(configuration.requestKey),
      requestFingerprint: ledger.requestFingerprint({
        capabilityId: cap.id,
        artifactDigest: cap.digest,
        tenant: 'a',
        inputs: configuration.inputs,
      }),
    });
    await live.page.route('**/core/application/review', async (route) => {
      // The application has accepted the draft. Hold its response so the worker
      // cannot verify a checkpoint before the parent forcibly terminates it.
      await route.fetch();
      process.send?.({ kind: 'accepted' });
      await new Promise<void>(() => {});
    });
    await engine.run();
    process.send?.({ kind: 'unexpected_completion' });
    await live.close();
    process.exit(1);
  } catch {
    process.send?.({ kind: 'worker_failed' });
    process.exit(1);
  }
});
