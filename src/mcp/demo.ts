import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startSimulator, SHADOW_INPUTS } from '../../sim/server.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const sourceMode = import.meta.url.endsWith('.ts');
const serverPath = fileURLToPath(
  new URL(sourceMode ? './server.ts' : './server.js', import.meta.url),
);
const simulator = await startSimulator();
const client = new Client({ name: 'capability-demo', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: sourceMode ? ['--import', 'tsx', serverPath] : [serverPath],
  stderr: 'inherit',
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    MCP_PRINCIPAL: 'agent-b',
  },
});
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  const tool = catalog.tools.find((t) => t.name !== 'run_status');
  if (!tool) throw new Error('No verified capability. Run real discovery first.');
  const started = await client.callTool({
    name: tool.name,
    arguments: { tenant: 'b', requestKey: randomUUID(), ...SHADOW_INPUTS },
  });
  if (started.isError) throw new Error('MCP invocation rejected');
  const runId = (started.structuredContent as { runId: string }).runId;
  let result: unknown;
  for (let i = 0; i < 240; i++) {
    const status = await client.callTool({ name: 'run_status', arguments: { runId } });
    const body = status.structuredContent as { result?: { status: string } };
    if (body.result) {
      result = body.result;
      if (body.result.status !== 'success') throw new Error('MCP invocation did not complete');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!result) throw new Error('MCP invocation timed out');
  await mkdir('evidence/mcp-invoke', { recursive: true });
  await writeFile(
    'evidence/mcp-invoke/result.json',
    JSON.stringify(
      {
        transport: 'stdio',
        listedTools: catalog.tools.map((t) => t.name),
        called: tool.name,
        tenant: 'b',
        status: 'success',
        outputs: 'withheld',
      },
      null,
      2,
    ),
  );
  console.log('MCP tools/list and tools/call completed on tenant B. Evidence saved.');
} finally {
  await client.close();
  await transport.close();
  await simulator.close();
}
