import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureCapability } from './fixture.js';
import { sealCapability, validateReferences } from '../src/compiler/compile.js';
import { validateInputs, DEMO_FIELDS, RouteSchema } from '../src/schema/index.js';
import { DEMO_INPUTS } from '../sim/server.js';
import { formatMinor, parseMoney } from '../src/schema/money.js';

describe('adversarial capability contracts', () => {
  it.each(['constructor', 'toString', '__proto__'])('rejects inherited target name %s', (key) => {
    const { digest: _, ...cap } = createFixtureCapability();
    cap.steps[1]!.action = { type: 'fill', target: key, value: { input: 'memberId' } };
    expect(() => validateReferences(sealCapability(cap))).toThrow('UNKNOWN_TARGET');
  });
  it('rejects an inherited input and output reference', () => {
    const { digest: _, ...cap } = createFixtureCapability();
    cap.completion = { op: 'outputEquals', output: 'constructor', input: 'toString' };
    expect(() => validateReferences(sealCapability(cap))).toThrow();
  });
  it.each([
    { template: '/core/:missing', bindings: {} },
    { template: '/core', bindings: { unused: { input: 'memberId' } } },
  ])('rejects missing or unused route bindings: %j', (route) => {
    const { digest: _, ...cap } = createFixtureCapability();
    cap.steps[0]!.action = { type: 'navigate', route: RouteSchema.parse(route) };
    expect(() => validateReferences(sealCapability(cap))).toThrow();
  });
  it('rejects an output parser incompatible with its declared type', () => {
    const { digest: _, ...cap } = createFixtureCapability();
    cap.outputs.memberId!.parser = 'usd_to_minor';
    expect(() => validateReferences(sealCapability(cap))).toThrow();
  });
  it.each([NaN, Infinity, -1, 0.01, Number.MAX_SAFE_INTEGER + 1, '15000', null])(
    'rejects invalid deposit %s before browser execution',
    (openingDepositMinor) => {
      expect(() => validateInputs(DEMO_FIELDS, { ...DEMO_INPUTS, openingDepositMinor })).toThrow();
    },
  );
  it('round-trips money at the safe-integer boundary and rejects malformed displays', () => {
    for (const value of [1, 29, 9999999, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER])
      expect(parseMoney(formatMinor(value))).toBe(value);
    for (const text of ['1e3', 'NaN', 'Infinity', '-1.00', '1,23.45', '1.000', '90071992547409.92'])
      expect(() => parseMoney(text)).toThrow();
  });
  it('rejects a valid artifact stored under another version and an empty verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'edge-registry-'));
    vi.stubEnv('CAPABILITY_DIR', dir);
    vi.resetModules();
    try {
      const reg = await import('../src/registry.js');
      const cap = createFixtureCapability();
      await reg.saveCapability(cap);
      await writeFile(join(dir, cap.id, 'v2.json'), JSON.stringify(cap));
      await expect(reg.loadCapability(cap.id, 2)).rejects.toThrow('ARTIFACT_IDENTITY_MISMATCH');
      await reg.markVerified(cap, ['a', 'b'], ['synthetic-evidence']);
      const path = join(dir, cap.id, 'v1.verified.json');
      const verification = JSON.parse(await readFile(path, 'utf8'));
      verification.evidence = [];
      await writeFile(path, JSON.stringify(verification));
      await expect(reg.verificationFor(cap)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
