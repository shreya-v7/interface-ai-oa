import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Deliberately no messages, URLs, values, exceptions, model text, or arbitrary metadata.
const stringFields = new Set([
  'runId',
  'stepId',
  'type',
  'actor',
  'action',
  'code',
  'state',
  'effect',
  'target',
  'observationId',
  'model',
  'interventionId',
]);
const numberFields = new Set([
  'epoch',
  'durationMs',
  'count',
  'inputTokens',
  'outputTokens',
  'costUsd',
]);
export function safeEvent(
  event: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = { timestamp: new Date().toISOString() };
  for (const [key, value] of Object.entries(event)) {
    if (stringFields.has(key) && typeof value === 'string' && /^[\w.\-:@/]{1,160}$/.test(value))
      result[key] = value;
    if (numberFields.has(key) && typeof value === 'number' && Number.isFinite(value))
      result[key] = value;
    if (key === 'assisted' && typeof value === 'boolean') result[key] = value;
  }
  return result;
}
export async function writeEvent(
  path: string | undefined,
  event: Record<string, unknown>,
): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(safeEvent(event)) + '\n', { mode: 0o600 });
}

export function structuralObservation(observation: {
  elements: Array<{ ref: string; frame: string[]; role: string; tag: string; type?: string }>;
}): unknown {
  return {
    elements: observation.elements.map((e) => ({
      ref: e.ref,
      frameDepth: e.frame.length,
      role: e.role,
      tag: e.tag,
      type: e.type,
    })),
  };
}
