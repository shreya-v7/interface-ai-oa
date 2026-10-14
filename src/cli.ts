import { parseArgs } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from 'dotenv';
import {
  startSimulator,
  DEMO_INPUTS,
  SHADOW_INPUTS,
  type ApplicationInputs,
  type Fault,
} from '../sim/server.js';
import { ReplayEngine } from './replay/engine.js';
import {
  loadCapability,
  loadLatestVerified,
  savedVersions,
  nextVersion,
  saveCapability,
  markVerified,
  verificationFor,
  registerEngine,
  waitForSettled,
  closeRuns,
  initializeRuntime,
} from './registry.js';
import { startOperatorServer, type OperatorManager } from './control/operator-server.js';
import { operatorManager } from './control/manager.js';
import { initializeOperatorCredential, OPERATOR_KEY_PATH } from './control/auth.js';
import { configuredOperatorAuth } from './control/operator-config.js';
import { OidcClient } from './control/oidc.js';
import { inspectDisplayedReview, reviewEquals, REVIEW_FIELDS } from '../eval/oracle.js';
import { createFixtureCapability } from '../fixtures/capability.js';
import {
  ContractSchema,
  DEMO_CONTRACT,
  type Capability,
  type Inputs,
  type RunResult,
} from './schema/index.js';
import { digestOf } from './compiler/compile.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    goal: { type: 'string' },
    tenant: { type: 'string', default: 'a' },
    cap: { type: 'string' },
    input: { type: 'string' },
    contract: { type: 'string' },
    'shadow-input': { type: 'string' },
    version: { type: 'string' },
    fixture: { type: 'boolean', default: false },
    headless: { type: 'boolean', default: false },
    sso: { type: 'boolean', default: false },
    scenario: { type: 'string' },
  },
});
const command = positionals[0];
type Simulator = Awaited<ReturnType<typeof startSimulator>>;
/**
 * The capability's birth certificate: replay it with NO model, on inputs it was not
 * discovered with, on both tenants. When it returns the savings review, the
 * independent oracle also checks the rendered screen and the simulator's records.
 * Used after discovery and by `verify` whenever the runtime changes.
 */
async function shadowVerify(
  cap: Capability,
  sim: Simulator,
  directory: string,
  shadowInputs: Inputs,
): Promise<string[]> {
  const oracleApplies = REVIEW_FIELDS.every((field) => field in cap.outputs);
  const evidence: string[] = [];
  for (const variant of ['a', 'b'] as const) {
    const shadow = { ...shadowInputs };
    const session = sim.createSession({
      tenant: variant,
      inputs: shadow as unknown as ApplicationInputs,
    });
    const engine = new ReplayEngine(cap, shadow, sim.profiles[variant], {
      cookies: [session.cookie],
      headless: true,
      journalPath: join(directory, `shadow-${variant}.jsonl`),
      evidenceDir: join(directory, `shadow-${variant}`),
    });
    try {
      const result = await engine.run();
      const independent =
        !oracleApplies ||
        (result.status === 'success' &&
          reviewEquals(shadow, result.outputs) &&
          reviewEquals(
            shadow,
            await inspectDisplayedReview(
              engine.surface.page,
              sim.profiles[variant].labelAliases as never,
            ),
          ) &&
          reviewEquals(shadow, sim.inspectSession(session.sessionId).draft ?? undefined));
      if (result.status !== 'success' || !independent)
        throw new Error(`SHADOW_REPLAY_FAILED_TENANT_${variant.toUpperCase()}`);
      const report = join(directory, `shadow-${variant}.json`);
      await writeFile(
        report,
        JSON.stringify(
          {
            artifactDigest: cap.digest,
            tenant: variant,
            source: cap.provenance.source,
            differentInputs: true,
            status: 'success',
            independentOracle: oracleApplies,
            modelCalls: 0,
          },
          null,
          2,
        ),
      );
      evidence.push(report);
    } finally {
      await engine.close();
    }
  }
  return evidence;
}
/** Best effort: open a local URL in the default browser; failure is harmless. */
function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    /* The printed URL remains the fallback. */
  }
}
function safeResult(result: RunResult) {
  return result.status === 'success'
    ? { ...result, outputs: 'withheld; verified in browser' }
    : result;
}
async function startConsole(options: { manager: OperatorManager }) {
  if (!values.sso) return startOperatorServer({ ...options, ...(await configuredOperatorAuth()) });
  const { startIdentityProvider, LOCAL_SSO_CLIENT_ID } = await import('../sim/identity.js');
  const identity = await startIdentityProvider({ port: 4104, redirectUris: [] });
  try {
    const oidc = await OidcClient.create({
      issuer: identity.issuer,
      clientId: LOCAL_SSO_CLIENT_ID,
      allowInsecureLoopback: true,
    });
    const operator = await startOperatorServer({ ...options, oidc });
    identity.registerRedirectUri(`${operator.url}/auth/callback`);
    console.log(
      'Local SSO accounts are in .runs/sso-users.json. Use the operator for this tenant, a read-only reviewer, or admin.',
    );
    return {
      url: operator.url,
      async close() {
        await operator.close();
        await identity.close();
      },
    };
  } catch (error) {
    await identity.close();
    throw error;
  }
}
function signInHint(): string {
  return values.sso || process.env.OPERATOR_AUTH === 'oidc'
    ? 'Select Sign in with SSO.'
    : `Sign in with OPERATOR_TOKEN or ${OPERATOR_KEY_PATH}.`;
}
async function main() {
  config({ quiet: true });
  if (command === 'operator:setup') {
    const credential = await initializeOperatorCredential();
    console.log(
      credential.path
        ? `Operator credential ready in ${credential.path}. Copy it into the console sign-in form.`
        : 'Operator credential configured through OPERATOR_TOKEN.',
    );
    return;
  }
  if (command === 'operator') {
    initializeRuntime();
    const operator = await startConsole({ manager: operatorManager });
    console.log(`Operator console: ${operator.url}. ${signInHint()}`);
    try {
      if (!values.headless) openInBrowser(operator.url);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    } finally {
      await operator.close();
      await closeRuns();
    }
    return;
  }
  const tenant = values.tenant;
  if (tenant !== 'a' && tenant !== 'b') throw new Error('UNKNOWN_TENANT');
  if (command === 'discover') {
    const { discover } = await import('./discovery/loop.js');
    // Bearer keys need AWS_BEARER_TOKEN_BEDROCK; SigV4 uses the standard AWS credential chain.
    if (process.env.BEDROCK_AUTH !== 'sigv4' && !process.env.AWS_BEARER_TOKEN_BEDROCK)
      throw new Error(
        'BEDROCK_CREDENTIALS_REQUIRED: set AWS_BEARER_TOKEN_BEDROCK, or BEDROCK_AUTH=sigv4 with AWS credentials, in local .env.',
      );
    const runId = randomUUID();
    const directory = join('evidence', 'discovery', runId);
    const inputs: Inputs = values.input
      ? JSON.parse(await readFile(values.input, 'utf8'))
      : { ...DEMO_INPUTS };
    const id = values.cap ?? 'open_savings_subaccount_to_review';
    const contract = values.contract
      ? ContractSchema.parse(JSON.parse(await readFile(values.contract, 'utf8')))
      : DEMO_CONTRACT;
    if (values.contract && !values['shadow-input'])
      throw new Error('SHADOW_INPUT_REQUIRED: a custom contract needs --shadow-input <path>.');
    const shadowInputs: Inputs = values['shadow-input']
      ? JSON.parse(await readFile(values['shadow-input'], 'utf8'))
      : { ...SHADOW_INPUTS };
    const sim = await startSimulator();
    let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
    try {
      const ticket = sim.createSession({ tenant, inputs: inputs as unknown as ApplicationInputs });
      console.log(
        'Starting REAL paid Bedrock discovery. Total model allowance: $3; runtime observations are synthetic.',
      );
      const discovered = await discover({
        profile: sim.profiles[tenant],
        inputs,
        contract,
        goal:
          values.goal ??
          'Find the specified member and prepare their savings sub-account application. Stop at the review screen and return the member ID, product code, nickname and opening deposit.',
        id,
        version: await nextVersion(id),
        runId,
        cookies: [ticket.cookie],
        startURL: ticket.entryUrl,
        headless: values.headless,
        journalPath: join(directory, 'events.jsonl'),
        onIntervention: async (live, reason) => {
          let release!: () => void;
          let stop!: (error: Error) => void;
          const resumed = new Promise<void>((resolve, reject) => {
            release = resolve;
            stop = reject;
          });
          const timeout = setTimeout(() => stop(new Error('DISCOVERY_HUMAN_TIMEOUT')), 600_000);
          try {
            operator = await startConsole({
              manager: {
                list: () => [
                  {
                    runId,
                    capability: 'Discovery in progress',
                    tenant,
                    state: live.session.state,
                    epoch: live.session.epoch,
                    owner: live.session.owner,
                    reason,
                  },
                ],
                control: async (_id, action, epoch) => {
                  if (_id !== runId || action === 'resolve') throw new Error('INVALID_COMMAND');
                  if (epoch !== live.session.epoch) throw new Error('STALE_CONTROL_EPOCH');
                  if (action === 'takeover') await live.session.takeover();
                  else if (action === 'abort') {
                    clearTimeout(timeout);
                    await live.session.abort();
                    stop(new Error('OPERATOR_ABORTED'));
                  } else {
                    await live.session.resume();
                    clearTimeout(timeout);
                    release();
                  }
                },
              },
            });
            console.log(`Discovery paused. Operator console: ${operator.url}. ${signInHint()}`);
            await resumed;
          } finally {
            clearTimeout(timeout);
            await operator?.close();
            operator = undefined;
          }
        },
      });
      const path = await saveCapability(discovered.capability);
      console.log(`Recorded candidate ${path}; checking different inputs on both tenants.`);
      const evidence = await shadowVerify(discovered.capability, sim, directory, shadowInputs);
      await markVerified(discovered.capability, ['a', 'b'], evidence);
      await writeFile(
        join(directory, 'summary.json'),
        JSON.stringify(
          {
            source: 'live',
            artifact: path,
            modelCalls: discovered.modelCalls,
            costUsd: discovered.costUsd,
            shadowReplays: 2,
            status: 'verified',
          },
          null,
          2,
        ),
      );
      console.log(
        `Live-discovered capability verified. Discovery used ${discovered.modelCalls} model calls; $${discovered.costUsd.toFixed(4)}.`,
      );
    } finally {
      await operator?.close();
      await sim.close();
    }
    return;
  }
  if (command === 'verify') {
    // Re-issue verification after a runtime/profile change; it never calls a model.
    const id = values.cap ?? 'open_savings_subaccount_to_review';
    const version = values.version ? Number(values.version) : (await savedVersions(id))[0];
    if (!version) throw new Error('CAPABILITY_NOT_FOUND');
    const cap = await loadCapability(id, version);
    const shadowInputs: Inputs = values['shadow-input']
      ? JSON.parse(await readFile(values['shadow-input'], 'utf8'))
      : { ...SHADOW_INPUTS };
    const directory = join('evidence', 'verification', `${id}-v${version}`);
    await rm(directory, { recursive: true, force: true });
    const sim = await startSimulator();
    try {
      await markVerified(cap, ['a', 'b'], await shadowVerify(cap, sim, directory, shadowInputs));
      console.log(
        `Verified ${id} v${version}: model-free replay on different inputs passed on both tenants.`,
      );
    } finally {
      await sim.close();
    }
    return;
  }
  if (!['demo:replay', 'demo:failure', 'demo:handoff'].includes(command ?? ''))
    throw new Error(
      'Choose discover, verify, demo:replay, demo:failure, demo:handoff, operator or operator:setup.',
    );
  const capId = values.cap ?? 'open_savings_subaccount_to_review';
  const cap: Capability = values.fixture
    ? createFixtureCapability()
    : values.version
      ? await loadCapability(capId, Number(values.version))
      : await loadLatestVerified(capId);
  if (values.fixture)
    console.log('HANDWRITTEN TEST FIXTURE - this is not evidence of model discovery.');
  const sim = await startSimulator();
  let operator: Awaited<ReturnType<typeof startOperatorServer>> | undefined;
  let engine: ReplayEngine | undefined;
  try {
    if (!values.fixture) {
      const verification = await verificationFor(cap);
      if (!verification.profileDigests.includes(digestOf(sim.profiles[tenant])))
        throw new Error('UNVERIFIED_PROFILE');
    }
    const inputs = values.input
      ? JSON.parse(await readFile(values.input, 'utf8'))
      : { ...SHADOW_INPUTS };
    const fault = (values.scenario ??
      (command === 'demo:handoff'
        ? 'session_expired'
        : command === 'demo:failure'
          ? 'wrong_amount_review'
          : 'none')) as Fault;
    const ticket = sim.createSession({ tenant, inputs, fault });
    const runId = randomUUID();
    // One folder per scenario and tenant, replaced on each run, so evidence/demos/ is
    // exactly what the README commands produce. Fixture runs stay out of evidence/.
    const name = `${fault === 'none' ? 'success' : fault}-${tenant}`;
    const directory = values.fixture
      ? join('.runs', 'fixture-demos', name)
      : join('evidence', 'demos', name);
    await rm(directory, { recursive: true, force: true });
    engine = new ReplayEngine(cap, inputs, sim.profiles[tenant], {
      cookies: [ticket.cookie],
      headless: values.headless,
      runId,
      journalPath: join(directory, 'events.jsonl'),
      evidenceDir: directory,
    });
    const entry = registerEngine(engine, cap.id, tenant);
    const result = await engine.run();
    entry.result = result;
    entry.state = result.status;
    console.log(JSON.stringify(safeResult(result), null, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify({ source: cap.provenance.source, result: safeResult(result) }, null, 2),
    );
    if (command === 'demo:handoff' && result.status === 'escalated') {
      operator = await startConsole({ manager: operatorManager });
      console.log(
        [
          '',
          'The run is PAUSED and waiting for you (10 minutes).',
          `  1. The operator console is opening in your browser: ${operator.url}`,
          `  2. ${signInHint()} Then click "Take control".`,
          '  3. In the Chromium window the run opened, enter the operator code demo-unlock',
          '     and click "Resume session".',
          '  4. Back in the console, click "Resume". The run checks the screen and finishes.',
          '',
        ].join('\n'),
      );
      // Put the next step in front of the operator instead of only in the terminal.
      if (!values.headless) openInBrowser(operator.url);
      // Resume clears entry.result while it runs, so wait for a terminal state.
      await waitForSettled(entry.runId, 600_000);
      await writeFile(
        join(directory, 'handoff-result.json'),
        JSON.stringify(
          {
            operator: engine.session.humanActor,
            sameSession: true,
            result: entry.result ? safeResult(entry.result) : null,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(entry.result ? safeResult(entry.result) : {}, null, 2));
    }
  } finally {
    await operator?.close();
    await engine?.close();
    await closeRuns();
    await sim.close();
  }
}
main().catch((error) => {
  const message = (error as Error).message;
  console.error(
    /^(ENOENT|CAPABILITY_NOT_FOUND|CAPABILITY_NOT_VERIFIED)/.test(message)
      ? `${message.split(':')[0]}: run real discovery, or use --fixture to explicitly test the handwritten fixture.`
      : message,
  );
  process.exitCode = 1;
});
