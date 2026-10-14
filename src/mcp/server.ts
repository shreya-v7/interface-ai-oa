import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import {
  listCapabilities,
  invokeSaved,
  runStatus,
  closeRuns,
  initializeRuntime,
} from '../registry.js';
import type { Capability } from '../schema/index.js';
import { startOperatorServer } from '../control/operator-server.js';
import { operatorManager } from '../control/manager.js';
import { config } from 'dotenv';
import { can, loadAccessPolicy, PrincipalSchema, type Principal } from '../control/access.js';
import { configuredOperatorAuth } from '../control/operator-config.js';

function inputSchema(cap: Capability, principal: Principal) {
  const tenants = ['a', 'b'].filter((tenant) => can(principal, tenant, 'invoke'));
  const properties: Record<string, unknown> = {
    tenant: { type: 'string', enum: tenants, default: tenants[0] },
    requestKey: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description:
        'Stable unique key for this logical request. Reuse on retries to avoid duplicate actions.',
    },
  };
  for (const [key, f] of Object.entries(cap.inputs))
    properties[key] = {
      type: f.type === 'integer' ? 'integer' : 'string',
      ...(f.min !== undefined ? { minimum: f.min } : {}),
      ...(f.max !== undefined ? { maximum: f.max } : {}),
      ...(f.pattern ? { pattern: f.pattern } : {}),
      ...(f.maxLength ? { maxLength: f.maxLength } : {}),
      ...(f.values ? { enum: f.values } : {}),
    };
  return {
    type: 'object' as const,
    properties,
    required: ['requestKey', ...Object.keys(cap.inputs)],
    additionalProperties: false,
  };
}
export async function createMcpServer(configuredPrincipal?: Principal) {
  const principal = configuredPrincipal
    ? PrincipalSchema.parse(configuredPrincipal)
    : (await loadAccessPolicy()).principal(process.env.MCP_PRINCIPAL ?? 'agent-a', 'service');
  if (principal.kind !== 'service') throw new Error('ACCESS_DENIED');
  const server = new Server(
    { name: 'verified-ui-capabilities', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(await listCapabilities())
        .filter(() => ['a', 'b'].some((tenant) => can(principal, tenant, 'invoke')))
        .map((cap) => ({
          name: `${cap.id}_v${cap.version}`,
          description: cap.description,
          inputSchema: inputSchema(cap, principal),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        })),
      {
        name: 'run_status',
        description: 'Read the state or final typed result of a capability invocation.',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string' } },
          required: ['runId'],
          additionalProperties: false,
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments ?? {};
      if (request.params.name === 'run_status') {
        if (typeof args.runId !== 'string' || Object.keys(args).some((k) => k !== 'runId'))
          throw new Error('INVALID_ARGUMENTS');
        const output = runStatus(args.runId, principal);
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }
      const cap = (await listCapabilities()).find(
        (c) => `${c.id}_v${c.version}` === request.params.name,
      );
      if (!cap) throw new Error('CAPABILITY_NOT_FOUND');
      const {
        tenant = principal.grants.find((grant) => can(principal, grant.tenant, 'invoke'))?.tenant,
        requestKey,
        ...inputs
      } = args;
      if (tenant !== 'a' && tenant !== 'b') throw new Error('UNKNOWN_TENANT');
      if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestKey))
        throw new Error('INVALID_REQUEST_KEY');
      const output = await invokeSaved(cap.id, inputs as never, tenant, {
        version: cap.version,
        expectedDigest: cap.digest,
        headless: process.env.MCP_HEADLESS === 'true',
        requestKey,
        principal,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const message = (error as Error).message;
      const code = /^[A-Z_]+$/.test(message) ? message : 'CAPABILITY_CALL_REJECTED';
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code }) }] };
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  config({ quiet: true });
  const operatorAuth = await configuredOperatorAuth();
  initializeRuntime();
  const server = await createMcpServer();
  const operator = await startOperatorServer({
    manager: operatorManager,
    port: Number(process.env.MCP_OPERATOR_PORT ?? 4100),
    ...operatorAuth,
  });
  await server.connect(new StdioServerTransport());
  console.error(
    `Local operator console: ${operator.url}. ${operatorAuth.oidc ? 'Select Sign in with SSO.' : 'Sign in with OPERATOR_TOKEN or .runs/operator-key.'}`,
  );
  const shutdown = async () => {
    await operator.close();
    await closeRuns();
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
