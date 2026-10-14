import { readFile } from 'node:fs/promises';
import { ProfileSchema, type Profile } from './schema/index.js';
export async function loadProfile(id: string): Promise<Profile> {
  if (id !== 'a' && id !== 'b') throw new Error('UNKNOWN_TENANT');
  return ProfileSchema.parse(
    JSON.parse(
      await readFile(new URL(`../vendor/legacy-core/tenants/${id}.json`, import.meta.url), 'utf8'),
    ),
  );
}
