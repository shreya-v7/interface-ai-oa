import type { Action, Profile } from '../schema/index.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const policy = z
  .object({
    id: z.string(),
    readPaths: z.array(z.string()),
    draftPostPaths: z.array(z.string()),
    automatedClickLabels: z.array(z.string()),
    fillableFields: z.array(z.string()),
    selectableFields: z.array(z.string()),
    forbiddenTargets: z.array(z.string()),
    allowDownloads: z.literal(false),
    allowPopups: z.literal(false),
    allowServiceWorkers: z.literal(false),
    allowWebSockets: z.literal(false),
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(new URL('../../vendor/legacy-core/policy.json', import.meta.url), 'utf8'),
    ),
  );

export class PolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PolicyError';
  }
}
export const READ_PATHS = new Set(policy.readPaths);
export const DRAFT_POST_PATHS = new Set(policy.draftPostPaths);
export function allowedUrl(raw: string, profile: Profile, method = 'GET'): boolean {
  try {
    const url = new URL(raw, profile.origin);
    if (
      url.origin !== new URL(profile.origin).origin ||
      url.username ||
      url.password ||
      !['http:', 'https:'].includes(url.protocol)
    )
      return false;
    if (url.pathname.includes('%') || url.pathname.includes('\\')) return false;
    if (method === 'GET' || method === 'HEAD') return READ_PATHS.has(url.pathname);
    return method === 'POST' && DRAFT_POST_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}
export function authorizeAction(
  action: Action,
  profile: Profile,
  url: string,
  target?: {
    role: string;
    name: string;
    type?: string;
    href?: string;
    formAction?: string;
    formMethod?: string;
  },
): void {
  if (url !== 'about:blank' && !allowedUrl(url, profile)) throw new PolicyError('ROUTE_BLOCKED');
  if (!['navigate', 'click', 'fill', 'select', 'read'].includes(action.type))
    throw new PolicyError('ACTION_BLOCKED');
  if (action.type === 'navigate') return;
  if (!target) throw new PolicyError('TARGET_NOT_AUTHORIZED');
  if (action.type === 'read') return;
  // Field names come from the same normalized label the observer computed (ARIA name,
  // <label>, or neighbouring table cell), so cell-labelled legacy fields are allowed.
  const resolve = (keys: string[]) =>
    keys.map((k) => (k.startsWith('@') ? profile.labelAliases[k.slice(1)] : k)).filter(Boolean);
  if (
    action.type === 'fill' &&
    (!['textbox', 'spinbutton'].includes(target.role) ||
      target.type === 'password' ||
      !resolve(policy.fillableFields).includes(target.name))
  )
    throw new PolicyError('FILL_TARGET_BLOCKED');
  if (
    action.type === 'select' &&
    (target.role !== 'combobox' || !resolve(policy.selectableFields).includes(target.name))
  )
    throw new PolicyError('SELECT_TARGET_BLOCKED');
  if (action.type === 'click') {
    const allowedNames = resolve(policy.automatedClickLabels);
    if (policy.forbiddenTargets.includes(target.name))
      throw new PolicyError('RISKY_OR_UNKNOWN_TARGET');
    if (!allowedNames.includes(target.name)) throw new PolicyError('RISKY_OR_UNKNOWN_TARGET');
    if (target.href && !allowedUrl(target.href, profile))
      throw new PolicyError('DESTINATION_BLOCKED');
    if (
      target.formAction &&
      !allowedUrl(target.formAction, profile, (target.formMethod ?? 'GET').toUpperCase())
    )
      throw new PolicyError('FORM_BLOCKED');
  }
}
