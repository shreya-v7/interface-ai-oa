import type { Inputs } from '../src/schema/index.js';

export type ExpectedClass = 'success' | 'business_outcome' | 'escalated' | 'failed';
export interface Scenario {
  id: string;
  expected: ExpectedClass;
  code?: string;
  requiresRecovery?: boolean;
}
export const SCENARIOS: readonly Scenario[] = [
  { id: 'none', expected: 'success' },
  { id: 'member_not_found', expected: 'business_outcome', code: 'MEMBER_NOT_FOUND' },
  { id: 'validation_min_deposit', expected: 'business_outcome', code: 'VALIDATION_REJECTED' },
  { id: 'permission_denied', expected: 'failed', code: 'PERMISSION_DENIED' },
  { id: 'interstitial_notice', expected: 'success', requiresRecovery: true },
  { id: 'session_expired', expected: 'escalated' },
  { id: 'slow_load', expected: 'success' },
  { id: 'app_error_500', expected: 'success', requiresRecovery: true },
  { id: 'ambiguous_duplicate_button', expected: 'escalated' },
  { id: 'wrong_member_review', expected: 'failed', code: 'COMPLETION_MISMATCH' },
  { id: 'wrong_amount_review', expected: 'failed', code: 'COMPLETION_MISMATCH' },
  { id: 'prompt_injection', expected: 'success' },
] as const;

export interface Episode {
  id: string;
  cohort: 'generalization' | 'repeatability';
  tenant: 'a' | 'b';
  scenario: Scenario;
  seed: number;
  repeat: number;
  inputs: Inputs;
}

/** Values vary by seed, not by execution timing. Never persist this object verbatim. */
export function syntheticInputs(seed: number, scenario: string): Inputs {
  let n = seed >>> 0;
  const draw = () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n;
  };
  return {
    memberId: String(100000 + (draw() % 800000)),
    productCode: draw() % 2 === 0 ? 'SAV-STD' : 'SAV-HY',
    nickname: `Eval-${seed.toString(36)}-${draw().toString(36).slice(0, 5)}`,
    openingDepositMinor: scenario === 'validation_min_deposit' ? 100 : 10000 + (draw() % 200000),
  };
}

export function buildEpisodes(repeats = 5): Episode[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('Invalid repeat count');
  const episodes: Episode[] = [];
  for (const tenant of ['a', 'b'] as const) {
    for (const [index, scenario] of SCENARIOS.entries()) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        const seed = 70001 + (tenant === 'b' ? 10000 : 0) + index * 100 + repeat;
        episodes.push({
          id: `${tenant}-${scenario.id}-${repeat + 1}`,
          cohort: 'generalization',
          tenant,
          scenario,
          seed,
          repeat,
          inputs: syntheticInputs(seed, scenario.id),
        });
      }
    }
    const seed = tenant === 'a' ? 91001 : 92001;
    for (let repeat = 0; repeat < repeats; repeat++)
      episodes.push({
        id: `${tenant}-fixed-${repeat + 1}`,
        cohort: 'repeatability',
        tenant,
        scenario: SCENARIOS[0]!,
        seed,
        repeat,
        inputs: syntheticInputs(seed, 'none'),
      });
  }
  return episodes;
}
