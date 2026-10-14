import { z } from 'zod';

export const ValueSchema = z.union([
  z.object({ input: z.string().min(1), format: z.enum(['minor_to_decimal']).optional() }).strict(),
  z.object({ const: z.union([z.string(), z.number().int()]) }).strict(),
]);
export type Value = z.infer<typeof ValueSchema>;
export type Inputs = Record<string, string | number>;
export const FieldSchema = z
  .object({
    type: z.enum(['string', 'integer', 'enum']),
    sensitivity: z.enum(['public', 'private']),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    pattern: z.string().optional(),
    values: z.array(z.string()).optional(),
  })
  .strict();
export const AnchorSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('label'), text: z.string() }).strict(),
  z.object({ by: z.literal('role'), role: z.string(), name: z.string() }).strict(),
  z.object({ by: z.literal('text'), text: z.string() }).strict(),
  z.object({ by: z.literal('near'), text: z.string() }).strict(),
  z
    .object({ by: z.literal('tableRow'), header: z.string(), key: ValueSchema, name: z.string() })
    .strict(),
]);
export type Anchor = z.infer<typeof AnchorSchema>;
export const TargetSchema = z
  .object({
    frame: z.array(z.string()),
    anchors: z.array(AnchorSchema).min(1).max(4),
    minAgree: z.number().int().min(1).max(4),
    required: z.array(z.number().int().min(0)).default([]),
  })
  .strict()
  .superRefine((t, c) => {
    if (t.minAgree > t.anchors.length || t.required.some((i) => i >= t.anchors.length))
      c.addIssue({ code: 'custom', message: 'Invalid anchor quorum' });
  });
export type Target = z.infer<typeof TargetSchema>;
export type Predicate =
  | { op: 'visible' | 'absent'; target: string }
  | { op: 'textEquals' | 'valueEquals'; target: string; value: Value }
  | { op: 'routeMatches'; template: string }
  | { op: 'outputEquals'; output: string; input: string }
  | { op: 'all' | 'any'; args: Predicate[] };
export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['visible', 'absent']), target: z.string() }).strict(),
    z
      .object({ op: z.enum(['textEquals', 'valueEquals']), target: z.string(), value: ValueSchema })
      .strict(),
    z.object({ op: z.literal('routeMatches'), template: z.string() }).strict(),
    z.object({ op: z.literal('outputEquals'), output: z.string(), input: z.string() }).strict(),
    z
      .object({ op: z.enum(['all', 'any']), args: z.array(PredicateSchema).min(1).max(20) })
      .strict(),
  ]),
);
export const RouteSchema = z
  .object({
    template: z.string().startsWith('/'),
    bindings: z.record(z.string(), ValueSchema).default({}),
  })
  .strict();
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), route: RouteSchema }).strict(),
  z.object({ type: z.literal('click'), target: z.string() }).strict(),
  z.object({ type: z.enum(['fill', 'select']), target: z.string(), value: ValueSchema }).strict(),
  z.object({ type: z.literal('read'), target: z.string(), output: z.string() }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;
export const StepSchema = z
  .object({
    id: z.string().min(1),
    action: ActionSchema,
    pre: PredicateSchema.optional(),
    post: PredicateSchema,
    effect: z.enum(['read', 'draft']),
    repeat: z.enum(['never', 'read', 'same_value']),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;
export const OutputSchema = z
  .object({
    type: z.enum(['string', 'integer']),
    from: z.string(),
    parser: z.enum(['text', 'usd_to_minor']),
  })
  .strict();
/**
 * Which input names the subject of the workflow, and where it is displayed. On any
 * screen whose heading is listed, every value shown next to `label` must equal that
 * input; otherwise replay stops with COMPLETION_MISMATCH. Labels are vendor keys
 * (`@memberId`) resolved through the tenant profile.
 */
export const IdentitySchema = z
  .object({ input: z.string(), label: z.string(), screens: z.array(z.string()).min(1) })
  .strict();
export const CapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    version: z.number().int().positive(),
    description: z.string().max(500),
    app: z.object({ vendor: z.string(), versions: z.array(z.string()).min(1) }).strict(),
    inputs: z.record(z.string(), FieldSchema),
    outputs: z.record(z.string(), OutputSchema),
    identity: IdentitySchema.optional(),
    targets: z.record(z.string(), TargetSchema),
    steps: z.array(StepSchema).min(1).max(40),
    completion: PredicateSchema,
    exceptions: z.string(),
    provenance: z
      .object({
        discoveryRun: z.string(),
        model: z.string(),
        source: z.enum(['live', 'test_fixture']),
        createdAt: z.string(),
      })
      .strict(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Capability = z.infer<typeof CapabilitySchema>;
export const ProfileSchema = z
  .object({
    id: z.enum(['a', 'b']),
    vendor: z.literal('legacy-core'),
    appVersion: z.literal('7.1'),
    origin: z.string().url(),
    frameAliases: z.record(z.string(), z.string()),
    labelAliases: z.record(z.string(), z.string()),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;
export interface UiElement {
  ref: string;
  frame: string[];
  role: string;
  name: string;
  text: string;
  value?: string;
  tag: string;
  type?: string;
  label?: string;
  near?: string;
  href?: string;
  /** Method of the form a button submits (`get`/`post`), if any. */
  formMethod?: string;
  row?: { header: string; key: string; name: string };
  options?: Array<{ label: string; value: string }>;
  anchors: Anchor[];
}
export interface Observation {
  id: string;
  url: string;
  elements: UiElement[];
  texts: string[];
}
export type EffectState = 'none' | 'applied' | 'unknown';
export type RunResult =
  | {
      status: 'success';
      outputs: Inputs;
      runId: string;
      recoveries: string[];
      drift: string[];
      assisted: boolean;
    }
  | { status: 'business_outcome'; code: string; runId: string; assisted: boolean }
  | {
      status: 'failed';
      code: string;
      stepId?: string;
      expected: string;
      observed: string;
      effect: EffectState;
      evidence: string[];
      runId: string;
      assisted: boolean;
    }
  | {
      status: 'escalated';
      interventionId: string;
      reason: string;
      runId: string;
      assisted: boolean;
    };
export const RunResultSchema: z.ZodType<RunResult> = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('success'),
      outputs: z.record(z.string(), z.union([z.string(), z.number().int()])),
      runId: z.string(),
      recoveries: z.array(z.string()),
      drift: z.array(z.string()),
      assisted: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('business_outcome'),
      code: z.string(),
      runId: z.string(),
      assisted: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      code: z.string(),
      stepId: z.string().optional(),
      expected: z.string(),
      observed: z.string(),
      effect: z.enum(['none', 'applied', 'unknown']),
      evidence: z.array(z.string()),
      runId: z.string(),
      assisted: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('escalated'),
      interventionId: z.string(),
      reason: z.string(),
      runId: z.string(),
      assisted: z.boolean(),
    })
    .strict(),
]);
export const DEMO_FIELDS: Record<string, z.infer<typeof FieldSchema>> = {
  memberId: { type: 'string', pattern: '^\\d{6}$', sensitivity: 'private' },
  productCode: { type: 'enum', values: ['SAV-STD', 'SAV-HY'], sensitivity: 'public' },
  nickname: { type: 'string', maxLength: 24, sensitivity: 'private' },
  openingDepositMinor: { type: 'integer', min: 0, max: 10_000_000, sensitivity: 'private' },
};
/**
 * What the caller asks discovery to produce: typed inputs, typed outputs to read back,
 * and an optional identity binding. It prescribes no steps.
 */
export const ContractSchema = z
  .object({
    inputs: z.record(z.string(), FieldSchema),
    outputs: z.record(
      z.string(),
      z
        .object({ type: z.enum(['string', 'integer']), parser: z.enum(['text', 'usd_to_minor']) })
        .strict(),
    ),
    identity: IdentitySchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!Object.keys(c.outputs).length) ctx.addIssue({ code: 'custom', message: 'No outputs' });
    if (c.identity && !c.inputs[c.identity.input])
      ctx.addIssue({ code: 'custom', message: 'Identity input is not declared' });
  });
export type Contract = z.infer<typeof ContractSchema>;
export const DEMO_CONTRACT: Contract = {
  inputs: DEMO_FIELDS,
  outputs: {
    memberId: { type: 'string', parser: 'text' },
    productCode: { type: 'string', parser: 'text' },
    nickname: { type: 'string', parser: 'text' },
    openingDepositMinor: { type: 'integer', parser: 'usd_to_minor' },
  },
  identity: {
    input: 'memberId',
    label: '@memberId',
    screens: ['@detailHeading', '@formHeading', '@reviewHeading'],
  },
};
export function validateInputs(fields: Capability['inputs'], inputs: unknown): Inputs {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (f.type === 'integer') {
      let s = z.number().int();
      if (f.min !== undefined) s = s.min(f.min);
      if (f.max !== undefined) s = s.max(f.max);
      shape[name] = s;
    } else {
      let s = z.string();
      if (f.maxLength !== undefined) s = s.max(f.maxLength);
      if (f.pattern) s = s.regex(new RegExp(f.pattern));
      shape[name] = f.type === 'enum' ? s.refine((v) => f.values?.includes(v) === true) : s;
    }
  }
  return z.object(shape).strict().parse(inputs) as Inputs;
}
