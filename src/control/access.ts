import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const Identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const GrantSchema = z
  .object({
    tenant: z.enum(['a', 'b']),
    role: z.enum(['viewer', 'operator', 'admin', 'agent']),
  })
  .strict();
export const PrincipalSchema = z
  .object({
    id: Identifier,
    kind: z.enum(['human', 'service']),
    grants: z.array(GrantSchema).min(1).max(2),
  })
  .strict()
  .refine((p) => new Set(p.grants.map((g) => g.tenant)).size === p.grants.length);
export type Principal = z.infer<typeof PrincipalSchema>;
export type Permission = 'read' | 'invoke' | 'control' | 'resolve';
const permissions: Record<Principal['grants'][number]['role'], readonly Permission[]> = {
  viewer: ['read'],
  operator: ['read', 'control'],
  admin: ['read', 'invoke', 'control', 'resolve'],
  agent: ['read', 'invoke'],
};
const PolicySchema = z
  .object({
    version: z.literal(1),
    principals: z
      .array(
        z
          .object({
            id: Identifier,
            kind: z.enum(['human', 'service']),
            subject: z.string().min(1).max(256).optional(),
            grants: z.array(GrantSchema).min(1).max(2),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

/** Identity comes from the verified issuer or trusted process configuration.
 * Tenant grants always come from this local policy, never from token claims. */
export class AccessPolicy {
  private readonly entries: z.infer<typeof PolicySchema>['principals'];
  constructor(configuration: unknown) {
    const parsed = PolicySchema.parse(configuration);
    const ids = new Set<string>(),
      subjects = new Set<string>();
    for (const entry of parsed.principals) {
      const { subject, ...principal } = entry;
      PrincipalSchema.parse(principal);
      if (
        ids.has(entry.id) ||
        (subject && subjects.has(subject)) ||
        (entry.kind === 'service' && subject)
      )
        throw new Error('ACCESS_POLICY_INVALID');
      ids.add(entry.id);
      if (subject) subjects.add(subject);
    }
    this.entries = parsed.principals;
  }
  principal(id: string, kind?: Principal['kind']): Principal {
    const entry = this.entries.find((item) => item.id === id && (!kind || item.kind === kind));
    if (!entry) throw new Error('ACCESS_DENIED');
    return PrincipalSchema.parse({ id: entry.id, kind: entry.kind, grants: entry.grants });
  }
  forSubject(subject: string): Principal {
    const entry = this.entries.find((item) => item.kind === 'human' && item.subject === subject);
    if (!entry) throw new Error('ACCESS_DENIED');
    return this.principal(entry.id, 'human');
  }
}
export async function loadAccessPolicy(
  path = process.env.ACCESS_POLICY_PATH,
): Promise<AccessPolicy> {
  try {
    return new AccessPolicy(
      JSON.parse(
        await readFile(path ?? new URL('../../config/access.json', import.meta.url), 'utf8'),
      ),
    );
  } catch {
    throw new Error('ACCESS_POLICY_INVALID');
  }
}
export function can(principal: Principal, tenant: string, permission: Permission): boolean {
  const parsed = PrincipalSchema.safeParse(principal);
  return (
    parsed.success &&
    parsed.data.grants.some(
      (grant) => grant.tenant === tenant && permissions[grant.role].includes(permission),
    )
  );
}
export function requirePermission(
  principal: Principal,
  tenant: string,
  permission: Permission,
): void {
  if (!can(principal, tenant, permission)) throw new Error('ACCESS_DENIED');
}
