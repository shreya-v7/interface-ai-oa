import { createHash } from 'node:crypto';
import {
  CapabilitySchema,
  type Capability,
  type Inputs,
  type Value,
  type Target,
  type Profile,
  type UiElement,
  type Action,
  type Step,
  type Predicate,
} from '../schema/index.js';
import { formatMinor } from '../schema/money.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('NON_JSON_VALUE');
  return result;
}
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function sealCapability(content: Omit<Capability, 'digest'>): Capability {
  const parsed = CapabilitySchema.parse({ ...content, digest: '0'.repeat(64) });
  const { digest: _, ...normalized } = parsed;
  return { ...parsed, digest: digestOf(normalized) };
}
export function verifyDigest(cap: Capability): void {
  const { digest, ...content } = cap;
  if (digestOf(content) !== digest) throw new Error('ARTIFACT_DIGEST_MISMATCH');
}
export function liftValue(raw: string, inputs: Inputs): Value {
  for (const [key, value] of Object.entries(inputs)) {
    if (raw === String(value)) return { input: key };
    if (typeof value === 'number' && raw === formatMinor(value))
      return { input: key, format: 'minor_to_decimal' };
  }
  return { const: raw };
}
export function canonicalRoute(
  url: string,
  profile: Profile,
  inputs: Inputs,
): { template: string; bindings: Record<string, Value> } {
  const parsed = new URL(url, profile.origin);
  if (parsed.origin !== profile.origin || parsed.search || parsed.hash)
    throw new Error('UNSUPPORTED_DYNAMIC_ROUTE');
  const bindings: Record<string, Value> = {};
  const segments = parsed.pathname.split('/').map((segment) => {
    const raw = decodeURIComponent(segment);
    const match = Object.entries(inputs).find(([, value]) => String(value) === raw);
    if (match) {
      bindings[match[0]] = { input: match[0] };
      return `:${match[0]}`;
    }
    return segment;
  });
  return { template: segments.join('/'), bindings };
}
function labelKey(text: string, profile: Profile): string {
  const found = Object.entries(profile.labelAliases).find(([, v]) => v === text);
  return found ? `@${found[0].replace(/^@/, '')}` : text;
}
export function targetFromElement(element: UiElement, profile: Profile, inputs: Inputs): Target {
  let anchors = element.anchors
    .map((anchor) => {
      if (anchor.by === 'tableRow')
        return {
          ...anchor,
          header: labelKey(anchor.header, profile),
          name: labelKey(anchor.name, profile),
          key: 'const' in anchor.key ? liftValue(String(anchor.key.const), inputs) : anchor.key,
        };
      if (anchor.by === 'role') return { ...anchor, name: labelKey(anchor.name, profile) };
      return { ...anchor, text: labelKey(anchor.text, profile) };
    })
    .filter((a, i, all) => all.findIndex((b) => canonical(a) === canonical(b)) === i)
    .slice(0, 4);
  // Broad "View" anchors are ambiguous across rows. The row-key relationship
  // is the actual scoped identity anchor and must never be voted away.
  if (anchors.some((a) => a.by === 'tableRow'))
    anchors = anchors.filter((a) => a.by === 'tableRow');
  else
    anchors = anchors.filter((a) => {
      const text = a.by === 'role' ? a.name : 'text' in a ? a.text : '';
      if (text.startsWith('@')) return true;
      try {
        assertNoDiscoveryLiterals(text, inputs);
        return true;
      } catch {
        return false;
      }
    });
  if (!anchors.length) throw new Error('UNGROUNDED_TARGET');
  const required = anchors.flatMap((a, i) => (a.by === 'tableRow' ? [i] : []));
  const frame = element.frame.map(
    (name) => Object.entries(profile.frameAliases).find(([, value]) => value === name)?.[0] ?? name,
  );
  return { frame, anchors, minAgree: required.length ? 1 : Math.min(2, anchors.length), required };
}
export function assertNoDiscoveryLiterals(value: unknown, inputs: Inputs): void {
  const candidates = new Set<string>();
  for (const v of Object.values(inputs)) {
    candidates.add(String(v));
    candidates.add(encodeURIComponent(String(v)));
    if (typeof v === 'number') {
      candidates.add(formatMinor(v));
      candidates.add(`$${formatMinor(v)}`);
    }
  }
  const visit = (item: unknown, path: string) => {
    if (typeof item === 'string') {
      for (const raw of candidates)
        if (raw && (item === raw || (raw.length >= 4 && item.includes(raw))))
          throw new Error(`DISCOVERY_LITERAL_AT:${path}`);
    } else if (Array.isArray(item)) item.forEach((v, i) => visit(v, `${path}.${i}`));
    else if (item && typeof item === 'object')
      for (const [k, v] of Object.entries(item)) {
        // Input names are symbolic identifiers, never concrete values.
        if (k === 'input') continue;
        visit(v, `${path}.${k}`);
      }
  };
  visit(value, 'artifact');
}
export interface RecordedStep {
  action: Action;
  pre?: Predicate;
  post: Predicate;
  effect: 'read' | 'draft';
  repeat: Step['repeat'];
}
export function compileCapability(options: {
  id: string;
  version: number;
  description: string;
  profile: Profile;
  inputs: Capability['inputs'];
  discoveryInputs: Inputs;
  targets: Record<string, Target>;
  steps: RecordedStep[];
  outputs: Capability['outputs'];
  identity?: Capability['identity'];
  completion: Predicate;
  runId: string;
  model: string;
  source?: 'live' | 'test_fixture';
}): Capability {
  const content: Omit<Capability, 'digest'> = {
    schemaVersion: 1,
    id: options.id,
    version: options.version,
    description: options.description,
    app: { vendor: options.profile.vendor, versions: [options.profile.appVersion] },
    inputs: options.inputs,
    outputs: options.outputs,
    ...(options.identity ? { identity: options.identity } : {}),
    targets: options.targets,
    steps: options.steps.map((s, i) => ({ ...s, id: `s${i + 1}`, timeoutMs: 10_000 })),
    completion: options.completion,
    exceptions: 'legacy-core@7:exceptions',
    provenance: {
      discoveryRun: options.runId,
      model: options.model,
      source: options.source ?? 'live',
      createdAt: new Date().toISOString(),
    },
  };
  assertNoDiscoveryLiterals(
    {
      targets: content.targets,
      steps: content.steps,
      outputs: content.outputs,
      completion: content.completion,
      description: content.description,
    },
    options.discoveryInputs,
  );
  const cap = sealCapability(content);
  validateReferences(cap);
  return cap;
}
export function validateReferences(cap: Capability): void {
  verifyDigest(cap);
  const ids = new Set<string>();
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.target === 'string' && !Object.hasOwn(cap.targets, o.target))
      throw new Error('UNKNOWN_TARGET');
    if (typeof o.input === 'string' && !Object.hasOwn(cap.inputs, o.input))
      throw new Error('UNKNOWN_INPUT');
    if (
      o.op === 'outputEquals' &&
      typeof o.output === 'string' &&
      !Object.hasOwn(cap.outputs, o.output)
    )
      throw new Error('UNKNOWN_OUTPUT');
    Object.values(o).forEach(visit);
  };
  for (const step of cap.steps) {
    if (ids.has(step.id)) throw new Error('DUPLICATE_STEP');
    ids.add(step.id);
    if (step.action.type === 'navigate') {
      const { template, bindings } = step.action.route;
      const names = new Set([...template.matchAll(/:([A-Za-z_][\w]*)/g)].map((m) => m[1]!));
      if (
        [...names].some((name) => !Object.hasOwn(bindings, name)) ||
        Object.keys(bindings).some((name) => !names.has(name))
      )
        throw new Error('ROUTE_BINDING_MISMATCH');
    }
    visit(step);
  }
  visit(cap.targets);
  visit(cap.completion);
  for (const output of Object.values(cap.outputs)) {
    if (!Object.hasOwn(cap.targets, output.from)) throw new Error('UNKNOWN_OUTPUT_TARGET');
    if ((output.type === 'integer') !== (output.parser === 'usd_to_minor'))
      throw new Error('OUTPUT_PARSER_TYPE_MISMATCH');
  }
  if (cap.identity && !Object.hasOwn(cap.inputs, cap.identity.input))
    throw new Error('UNKNOWN_IDENTITY_INPUT');
}
