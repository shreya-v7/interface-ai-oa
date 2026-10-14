import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Budget } from '../src/discovery/budget.js';
import { BedrockDiscoveryClient } from '../src/discovery/bedrock.js';

it('reserves shared spend before sending and retains uncertain reservations', async () => {
  await mkdir('.runs', { recursive: true });
  const dir = await mkdtemp('.runs/budget-');
  const path = join(dir, 'ledger.json');
  try {
    const budget = new Budget(path, 0.01);
    const id = await budget.reserve(100, 100);
    await budget.settle(id, 50, 50);
    await budget.reserve(1000, 500);
    await expect(budget.reserve(1000, 500)).rejects.toThrow('MODEL_BUDGET_EXHAUSTED');
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    expect(ledger.charges).toHaveLength(2);
    expect(ledger.charges[1].status).toBe('reserved');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses only the fixed Bedrock endpoint and keeps auth and provider bodies out of evidence', async () => {
  await mkdir('.runs', { recursive: true });
  const dir = await mkdtemp('.runs/provider-');
  const old = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'SENTINEL_PRIVATE_TOKEN';
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.openai.gpt-6.1-sol/converse',
    );
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer SENTINEL_PRIVATE_TOKEN',
    );
    const body = JSON.parse(String(init!.body));
    expect(body.toolConfig.tools[0].toolSpec.name).toBe('decide');
    // Bedrock needs an object at the top; the union is wrapped in `decision`.
    expect(body.toolConfig.tools[0].toolSpec.inputSchema.json).toMatchObject({
      type: 'object',
      required: ['decision'],
      properties: { decision: { type: 'object' } },
    });
    return new Response(
      JSON.stringify({
        output: {
          message: {
            content: [
              {
                toolUse: {
                  name: 'decide',
                  input: { decision: { kind: 'request_help', reason: 'stuck' } },
                },
              },
            ],
          },
        },
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
      { status: 200 },
    );
  });
  try {
    const journal = join(dir, 'events.jsonl');
    const client = new BedrockDiscoveryClient({
      runId: 'provider-test',
      budget: new Budget(join(dir, 'budget.json')),
      journalPath: journal,
    });
    expect(
      (await client.decide('test prompt', 'synthetic only', { type: 'object' })).decision,
    ).toEqual({ kind: 'request_help', reason: 'stuck' });
    expect(await readFile(journal, 'utf8')).not.toContain('SENTINEL');
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    if (old === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = old;
    await rm(dir, { recursive: true, force: true });
  }
});

it('signs with SigV4 through the SDK, unwraps the decision, and sanitizes provider errors', async () => {
  const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
  await mkdir('.runs', { recursive: true });
  const dir = await mkdtemp('.runs/sigv4-');
  const sent: Array<Record<string, unknown>> = [];
  let fail = false;
  const spy = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation((async (command: {
    input: Record<string, unknown>;
  }) => {
    sent.push(command.input);
    if (fail)
      throw Object.assign(new Error('echo of SENTINEL_PROMPT_TEXT'), {
        name: 'AccessDeniedException',
      });
    return {
      output: {
        message: {
          content: [
            {
              toolUse: { name: 'decide', input: { decision: { kind: 'checkpoint', ref: 'o1' } } },
            },
          ],
        },
      },
      usage: { inputTokens: 1000, outputTokens: 20 },
    } as never;
  }) as never);
  try {
    const budget = new Budget(join(dir, 'budget.json'));
    const client = new BedrockDiscoveryClient({
      runId: 'sigv4-test',
      budget,
      auth: 'sigv4',
      model: 'us.amazon.nova-2-lite-v1:0',
    });
    const reply = await client.decide('system', 'SENTINEL_PROMPT_TEXT', {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      oneOf: [{ type: 'object' }],
    });
    expect(reply.decision).toEqual({ kind: 'checkpoint', ref: 'o1' });
    // Billed at the model's own reviewed rate, not a default.
    expect(reply.costUsd).toBeCloseTo((1000 * 0.33 + 20 * 2.75) / 1e6, 10);
    expect(sent[0]!.modelId).toBe('us.amazon.nova-2-lite-v1:0');
    const schema = (
      sent[0]!.toolConfig as {
        tools: Array<{ toolSpec: { inputSchema: { json: Record<string, unknown> } } }>;
      }
    ).tools[0]!.toolSpec.inputSchema.json;
    expect(schema).toMatchObject({ type: 'object', required: ['decision'] });
    expect(JSON.stringify(schema)).not.toContain('$schema');
    fail = true;
    const error = await client
      .decide('system', 'SENTINEL_PROMPT_TEXT', { type: 'object' })
      .catch((e) => e);
    expect(error.message).toBe('BEDROCK_AccessDeniedException_RESERVATION_RETAINED');
    const ledger = JSON.parse(await readFile(join(dir, 'budget.json'), 'utf8'));
    expect(ledger.charges.map((c: { status: string }) => c.status)).toEqual([
      'settled',
      'reserved',
    ]);
  } finally {
    spy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects an unknown model or auth mode before any request', () => {
  expect(() => new BedrockDiscoveryClient({ runId: 'x', model: 'us.example.unpriced' })).toThrow(
    'UNBUDGETED_PROVIDER_CONFIGURATION',
  );
  expect(() => new BedrockDiscoveryClient({ runId: 'x', auth: 'basic' as never })).toThrow(
    'UNKNOWN_BEDROCK_AUTH',
  );
});
