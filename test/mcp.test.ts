import { it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startSimulator, SHADOW_INPUTS } from '../sim/server.js';
import { createFixtureCapability } from './fixture.js';
import { digestOf } from '../src/compiler/compile.js';
import { runtimeFingerprint } from '../src/registry.js';
import { RunStore } from '../src/control/run-store.js';

it('lists a verified fixture and invokes it through the real stdio MCP transport', async () => {
  await mkdir('.runs', { recursive: true });
  const dir = resolve(await mkdtemp('.runs/mcp-'));
  const sim = await startSimulator();
  const cap = createFixtureCapability();
  await mkdir(join(dir, cap.id));
  await writeFile(join(dir, cap.id, 'v1.json'), JSON.stringify(cap));
  await writeFile(
    join(dir, cap.id, 'v1.verified.json'),
    JSON.stringify({
      artifactDigest: cap.digest,
      profileDigests: Object.values(sim.profiles).map(digestOf),
      runtimeDigest: await runtimeFingerprint(),
      runtimeVersion: '0.1.0',
      verifiedAt: new Date().toISOString(),
      source: 'test_fixture',
      evidence: ['test-only'],
    }),
  );
  const foreignRun = 'tenant-a-private-run';
  const seed = new RunStore(join(dir, 'runtime'));
  seed.create({
    runId: foreignRun,
    capabilityId: cap.id,
    artifactDigest: cap.digest,
    tenant: 'a',
    createdBy: 'agent-a',
  });
  seed.transition(foreignRun, 'success');
  seed.dispose();
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp/server.ts'],
    env: {
      ...env,
      CAPABILITY_DIR: dir,
      AWS_BEARER_TOKEN_BEDROCK: '',
      MCP_HEADLESS: 'true',
      MCP_OPERATOR_PORT: '0',
      MCP_PRINCIPAL: 'agent-b',
      OPERATOR_AUTH: 'key',
      ACCESS_POLICY_PATH: resolve('config/access.json'),
      RUN_STATE_DIR: join(dir, 'runtime'),
      OPERATOR_TOKEN: 'test-only-operator-credential-at-least-32-characters',
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'integration-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const name = `${cap.id}_v1`;
    expect(tools.tools.some((t) => t.name === name)).toBe(true);
    expect(tools.tools.find((t) => t.name === name)?.inputSchema.properties?.tenant).toEqual({
      type: 'string',
      enum: ['b'],
      default: 'b',
    });
    const foreign = await client.callTool({ name: 'run_status', arguments: { runId: foreignRun } });
    const missing = await client.callTool({
      name: 'run_status',
      arguments: { runId: 'missing-run' },
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toEqual(missing.content);
    expect(JSON.stringify(foreign.content)).toContain('RUN_NOT_FOUND');
    expect(foreign.structuredContent).toBeUndefined();
    const forgedPrincipal = {
      id: 'admin',
      kind: 'human',
      grants: [{ tenant: 'a', role: 'admin' }],
    };
    const denied = await client.callTool({
      name,
      arguments: {
        tenant: 'a',
        requestKey: 'denied-tenant',
        ...SHADOW_INPUTS,
        principal: forgedPrincipal,
      },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED');
    const forged = await client.callTool({
      name,
      arguments: {
        tenant: 'b',
        requestKey: 'forged-identity',
        ...SHADOW_INPUTS,
        principal: forgedPrincipal,
      },
    });
    expect(forged.isError).toBe(true);
    const forgedStatus = await client.callTool({
      name: 'run_status',
      arguments: { runId: foreignRun, principal: forgedPrincipal },
    });
    expect(forgedStatus.isError).toBe(true);
    expect(JSON.stringify(forgedStatus.content)).toContain('INVALID_ARGUMENTS');
    const untouched = JSON.parse(await readFile(join(dir, 'runtime', 'runs.json'), 'utf8')) as {
      runs: { runId: string }[];
    };
    expect(untouched.runs.map((record) => record.runId)).toEqual([foreignRun]);
    const invalid = await client.callTool({ name, arguments: { memberId: 'wrong' } });
    expect(invalid.isError).toBe(true);
    const arguments_ = { tenant: 'b', requestKey: 'mcp-integration', ...SHADOW_INPUTS };
    const started = await client.callTool({ name, arguments: arguments_ });
    expect(started.isError).not.toBe(true);
    const runId = (started.structuredContent as { runId: string }).runId;
    const duplicate = await client.callTool({ name, arguments: arguments_ });
    expect(duplicate.structuredContent).toEqual({ runId });
    const defaultTenantRetry = await client.callTool({
      name,
      arguments: { requestKey: arguments_.requestKey, ...SHADOW_INPUTS },
    });
    expect(defaultTenantRetry.structuredContent).toEqual({ runId });
    const conflict = await client.callTool({
      name,
      arguments: { ...arguments_, nickname: 'Another' },
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.content)).toContain('IDEMPOTENCY_CONFLICT');
    let result: unknown;
    for (let n = 0; n < 100; n++) {
      const status = await client.callTool({ name: 'run_status', arguments: { runId } });
      const data = status.structuredContent as { result?: unknown };
      if (data.result) {
        result = data.result;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'success',
      outputs: SHADOW_INPUTS,
    });
    const final = await client.callTool({ name: 'run_status', arguments: { runId } });
    expect(final.structuredContent).toMatchObject({
      durable: { tenant: 'b', createdBy: 'agent-b' },
    });
  } finally {
    await client.close();
    await transport.close();
    await sim.close();
    await rm(dir, { recursive: true, force: true });
  }
});
