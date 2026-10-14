import { it, expect } from 'vitest';
import { startSimulator, DEMO_INPUTS, SHADOW_INPUTS } from '../sim/server.js';
import { DEMO_CONTRACT } from '../src/schema/index.js';
import { discover } from '../src/discovery/loop.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { assertNoDiscoveryLiterals } from '../src/compiler/compile.js';

it('compiles actual browser actions selected by a labeled scripted model double, then replays changed inputs', async () => {
  const sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
  let turn = 0;
  const client = {
    model: 'SCRIPTED_TEST_DOUBLE_NOT_LIVE',
    decide: async (_system: string, prompt: string) => {
      const observation = JSON.parse(prompt).observation as {
        elements: Array<{
          ref: string;
          name: string;
          text: string;
          role: string;
          row?: { key: string };
        }>;
      };
      const find = (predicate: (e: (typeof observation.elements)[number]) => boolean) => {
        const element = observation.elements.find(predicate);
        if (!element) throw new Error('TEST_ELEMENT_NOT_OBSERVED');
        return element.ref;
      };
      const heading = (name: string) => ({
        kind: 'checkpoint',
        ref: find((e) => e.role === 'heading' && e.name === name),
      });
      const click = (name: string) => ({
        kind: 'act',
        action: 'click',
        ref: find((e) => ['button', 'link'].includes(e.role) && e.name === name),
      });
      const fill = (name: string, input: string, format?: string) => ({
        kind: 'act',
        action: 'fill',
        ref: find((e) => e.role === 'textbox' && e.name === name),
        value: { input, ...(format ? { format } : {}) },
      });
      let decision: unknown;
      switch (turn++) {
        case 0:
          decision = heading('Member search');
          break;
        case 1:
          decision = fill('Member #', 'memberId');
          break;
        case 2:
          decision = click('Search');
          break;
        case 3:
          decision = heading('Search results');
          break;
        case 4:
          decision = {
            kind: 'act',
            action: 'click',
            ref: find((e) => e.row?.key === DEMO_INPUTS.memberId),
          };
          break;
        case 5:
          decision = heading('Member details');
          break;
        case 6:
          decision = click('New Sub-Account');
          break;
        case 7:
          decision = heading('Savings application');
          break;
        case 8:
          decision = {
            kind: 'act',
            action: 'select',
            ref: find((e) => e.role === 'combobox'),
            value: { input: 'productCode' },
          };
          break;
        case 9:
          decision = fill('Nickname', 'nickname');
          break;
        case 10:
          decision = fill('Opening deposit', 'openingDepositMinor', 'minor_to_decimal');
          break;
        case 11:
          decision = click('Review application');
          break;
        case 12:
          decision = heading('Review savings application');
          break;
        default:
          decision = {
            kind: 'finish',
            completionRef: find(
              (e) => e.role === 'heading' && e.name === 'Review savings application',
            ),
            outputs: {
              memberId: find((e) => e.text === DEMO_INPUTS.memberId),
              productCode: find((e) => e.text === DEMO_INPUTS.productCode),
              nickname: find((e) => e.text === DEMO_INPUTS.nickname),
              openingDepositMinor: find((e) => e.text === '$50.00'),
            },
          };
      }
      return { decision, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    },
  };
  try {
    const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
    const result = await discover({
      profile: sim.profiles.a,
      inputs: { ...DEMO_INPUTS },
      contract: DEMO_CONTRACT,
      goal: 'Prepare a savings application for review',
      cookies: [ticket.cookie],
      startURL: ticket.entryUrl,
      headless: true,
      client,
    });
    expect(result.capability.provenance.source).toBe('test_fixture');
    expect(result.capability.steps).toHaveLength(9);
    assertNoDiscoveryLiterals(
      { targets: result.capability.targets, steps: result.capability.steps },
      { ...DEMO_INPUTS },
    );
    const shadow = sim.createSession({ tenant: 'b', inputs: SHADOW_INPUTS });
    const engine = new ReplayEngine(result.capability, { ...SHADOW_INPUTS }, sim.profiles.b, {
      cookies: [shadow.cookie],
    });
    try {
      expect(await engine.run()).toMatchObject({ status: 'success', outputs: SHADOW_INPUTS });
    } finally {
      await engine.close();
    }
  } finally {
    await sim.close();
  }
});

it('refuses to finish while a contract input is unbound and rejects idle re-checkpoints', async () => {
  const sim = await startSimulator({ ports: { a: 0, b: 0, control: 0 } });
  const prompts: Array<{
    pendingInputs: string[];
    history: Array<{ action: string; input?: string }>;
    lastResults: Array<{ code: string; inputs?: string[]; hint?: string }>;
    observation: {
      elements: Array<{
        ref: string;
        name: string;
        text: string;
        role: string;
        row?: { key: string };
      }>;
    };
  }> = [];
  const plan: Array<(p: (typeof prompts)[number]) => unknown> = [];
  const find = (
    p: (typeof prompts)[number],
    test: (e: (typeof p.observation.elements)[number]) => boolean,
  ) => p.observation.elements.find(test)!.ref;
  const heading = (name: string) => (p: (typeof prompts)[number]) => ({
    kind: 'checkpoint',
    ref: find(p, (e) => e.role === 'heading' && e.name === name),
  });
  const click = (name: string) => (p: (typeof prompts)[number]) => ({
    kind: 'act',
    action: 'click',
    ref: find(p, (e) => ['button', 'link'].includes(e.role) && e.name === name),
  });
  const fill = (name: string, input: string, format?: string) => (p: (typeof prompts)[number]) => ({
    kind: 'act',
    action: 'fill',
    ref: find(p, (e) => e.role === 'textbox' && e.name === name),
    value: { input, ...(format ? { format } : {}) },
  });
  plan.push(
    heading('Member search'),
    heading('Member search'), // idle re-checkpoint: must be rejected
    fill('Member #', 'memberId'),
    click('Search'),
    heading('Search results'),
    (p) => ({
      kind: 'act',
      action: 'click',
      ref: find(p, (e) => e.row?.key === DEMO_INPUTS.memberId),
    }),
    heading('Member details'),
    click('New Sub-Account'),
    heading('Savings application'),
    // productCode deliberately skipped: the form default happens to match.
    fill('Nickname', 'nickname'),
    fill('Opening deposit', 'openingDepositMinor', 'minor_to_decimal'),
    click('Review application'),
    heading('Review savings application'),
    (p) => ({
      kind: 'finish',
      completionRef: find(
        p,
        (e) => e.role === 'heading' && e.name === 'Review savings application',
      ),
      outputs: {
        memberId: find(p, (e) => e.text === DEMO_INPUTS.memberId),
        productCode: find(p, (e) => e.text === DEMO_INPUTS.productCode),
        nickname: find(p, (e) => e.text === DEMO_INPUTS.nickname),
        openingDepositMinor: find(p, (e) => e.text === '$50.00'),
      },
    }),
    () => ({ kind: 'request_help', reason: 'stuck' }),
  );
  const client = {
    model: 'SCRIPTED_TEST_DOUBLE_NOT_LIVE',
    decide: async (_system: string, prompt: string) => {
      const parsed = JSON.parse(prompt);
      prompts.push(parsed);
      return {
        decision: plan[prompts.length - 1]!(parsed),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    },
  };
  try {
    const ticket = sim.createSession({ tenant: 'a', inputs: DEMO_INPUTS });
    await expect(
      discover({
        profile: sim.profiles.a,
        inputs: { ...DEMO_INPUTS },
        contract: DEMO_CONTRACT,
        goal: 'Prepare a savings application for review',
        cookies: [ticket.cookie],
        startURL: ticket.entryUrl,
        headless: true,
        client,
      }),
    ).rejects.toThrow('DISCOVERY_INTERVENTION_REQUIRED');
    expect(prompts[2]!.lastResults.at(-1)?.code).toBe('CHECKPOINT_ALREADY_VERIFIED');
    const atReview = prompts.at(-1)!;
    expect(atReview.pendingInputs).toEqual(['productCode']);
    expect(atReview.lastResults.at(-1)).toMatchObject({
      code: 'INPUTS_NOT_USED',
      inputs: ['productCode'],
    });
    expect(atReview.history.map((h) => h.input).filter(Boolean)).toEqual([
      'memberId',
      'nickname',
      'openingDepositMinor',
    ]);
  } finally {
    await sim.close();
  }
});
