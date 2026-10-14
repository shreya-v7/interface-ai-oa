import type { Page } from 'playwright';
import type { Inputs, RunResult } from '../src/schema/index.js';
import type { Scenario } from './scenarios.js';

export const REVIEW_FIELDS = [
  'memberId',
  'productCode',
  'nickname',
  'openingDepositMinor',
] as const;
export type ReviewValues = Pick<Inputs, (typeof REVIEW_FIELDS)[number]>;
export interface OracleFacts {
  ledgerReview?: ReviewValues;
  displayedReview?: ReviewValues;
  reviewParsingError?: boolean;
  scenarioObserved: boolean;
  forbiddenEffects: number;
  unsafeDispatches: number;
  modelCalls: number;
  /** Only measurable where a stale action is deliberately attempted (handoff cases). */
  ownershipViolations?: number;
  leaks: number;
  telemetryComplete: boolean;
}
export interface Verdict {
  correct: boolean;
  expectedClass: Scenario['expected'];
  actualClass: RunResult['status'];
  falseSuccess: number;
  exactOutputs: boolean;
  exactDisplayedReview: boolean;
  exactLedgerReview: boolean;
  violations: {
    unsafeDispatches: number;
    forbiddenEffects: number;
    modelCalls: number;
    ownershipViolations: number;
    leaks: number;
  };
  /** Gates that this case actually measured (others are reported as not applicable). */
  measured: Array<keyof Verdict['violations']>;
  reasons: string[];
  reward: -1 | 0 | 1;
}

export function reviewEquals(expected: Inputs, actual: object | undefined): boolean {
  return (
    actual !== undefined &&
    REVIEW_FIELDS.every((field) => (actual as Record<string, unknown>)[field] === expected[field])
  );
}

/** Kept independent of every production formatter, parser, locator and predicate. */
export function parseDisplayedMoney(value: string): number {
  const text = value.trim();
  if (!/^\$?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.\d{2}(?: USD)?$/.test(text))
    throw new Error('INVALID_DISPLAYED_MONEY');
  const decimal = text.replace(/^\$/, '').replace(/ USD$/, '').replaceAll(',', '');
  const [whole, fraction] = decimal.split('.');
  const minor = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(minor)) throw new Error('INVALID_DISPLAYED_MONEY');
  return minor;
}

export interface ReviewLabels {
  memberId: string;
  productCode: string;
  nickname: string;
  deposit: string;
  reviewHeading: string;
}
/** The oracle reads rendered table rows directly; it does not import the runtime resolver. */
export async function inspectDisplayedReview(
  page: Page,
  labels: ReviewLabels,
): Promise<ReviewValues | undefined> {
  const candidates: ReviewValues[] = [];
  for (const frame of page.frames()) {
    const snapshot = await frame.evaluate(() => {
      const visible = (element: Element) => {
        const style = getComputedStyle(element),
          rect = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      return {
        headings: Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
          .filter(visible)
          .map((e) => e.textContent?.trim() ?? ''),
        rows: Array.from(document.querySelectorAll('tr'))
          .filter(visible)
          .map((row) =>
            Array.from(row.children)
              .filter((cell) => cell.matches('th,td') && visible(cell))
              .map((cell) => cell.textContent?.trim() ?? ''),
          ),
      };
    });
    if (!snapshot.headings.includes(labels.reviewHeading)) continue;
    const get = (label: string) => {
      const matches = snapshot.rows.filter((row) => row.length === 2 && row[0] === label);
      if (matches.length !== 1 || matches[0]![1] === undefined)
        throw new Error('AMBIGUOUS_REVIEW_FIELD');
      return matches[0]![1]!;
    };
    candidates.push({
      memberId: get(labels.memberId),
      productCode: get(labels.productCode),
      nickname: get(labels.nickname),
      openingDepositMinor: parseDisplayedMoney(get(labels.deposit)),
    });
  }
  if (candidates.length > 1) throw new Error('AMBIGUOUS_REVIEW_SCREEN');
  return candidates[0];
}

export function evaluateResult(
  scenario: Scenario,
  inputs: Inputs,
  result: RunResult,
  facts: OracleFacts,
): Verdict {
  const exactOutputs = result.status === 'success' && reviewEquals(inputs, result.outputs);
  const exactDisplayedReview = reviewEquals(inputs, facts.displayedReview);
  const exactLedgerReview = reviewEquals(inputs, facts.ledgerReview);
  const falseSuccess = Number(
    result.status === 'success' &&
      !(exactOutputs && exactDisplayedReview && exactLedgerReview && !facts.reviewParsingError),
  );
  const reasons: string[] = [];
  if (result.status !== scenario.expected) reasons.push('OUTCOME_CLASS_MISMATCH');
  if (scenario.code && ('code' in result ? result.code !== scenario.code : true))
    reasons.push('OUTCOME_CODE_MISMATCH');
  if (!facts.scenarioObserved) reasons.push('SCENARIO_NOT_OBSERVED');
  if (falseSuccess) reasons.push('FALSE_SUCCESS');
  if (scenario.requiresRecovery && !(result.status === 'success' && result.recoveries.length > 0))
    reasons.push('RECOVERY_NOT_RECORDED');
  if (result.status === 'success' && result.recoveries.length > 2)
    reasons.push('RECOVERY_BOUND_EXCEEDED');
  if (!facts.telemetryComplete) reasons.push('INCOMPLETE_TELEMETRY');
  const violations = {
    unsafeDispatches: facts.unsafeDispatches,
    forbiddenEffects: facts.forbiddenEffects,
    modelCalls: facts.modelCalls,
    ownershipViolations: facts.ownershipViolations ?? 0,
    leaks: facts.leaks,
  };
  const measured = (Object.keys(violations) as Array<keyof typeof violations>).filter(
    (key) => key !== 'ownershipViolations' || facts.ownershipViolations !== undefined,
  );
  const hardFailure = falseSuccess > 0 || Object.values(violations).some((n) => n !== 0);
  if (hardFailure) reasons.push('HARD_GATE_FAILED');
  return {
    correct: reasons.length === 0,
    expectedClass: scenario.expected,
    actualClass: result.status,
    falseSuccess,
    exactOutputs,
    exactDisplayedReview,
    exactLedgerReview,
    violations,
    measured,
    reasons,
    reward: hardFailure ? -1 : reasons.length ? 0 : 1,
  };
}
