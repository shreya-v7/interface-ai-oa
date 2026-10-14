import { readFileSync } from 'node:fs';
import { ProfileSchema, type Profile } from '../../src/schema/index.js';

const base = Object.fromEntries(
  (['a', 'b'] as const).map((id) => [
    id,
    ProfileSchema.parse(
      JSON.parse(readFileSync(new URL(`./tenants/${id}.json`, import.meta.url), 'utf8')),
    ),
  ]),
) as Record<'a' | 'b', Profile>;

export function makeProfiles(origins: Record<'a' | 'b', string>): Record<'a' | 'b', Profile> {
  return {
    a: { ...structuredClone(base.a), origin: origins.a },
    b: { ...structuredClone(base.b), origin: origins.b },
  };
}
