import type { ApplicationInputs, Member } from './types.js';

export const DEMO_INPUTS: ApplicationInputs = {
  memberId: '100234',
  productCode: 'SAV-STD',
  nickname: 'Rainy day',
  openingDepositMinor: 5000,
};
export const SHADOW_INPUTS: ApplicationInputs = {
  memberId: '200345',
  productCode: 'SAV-HY',
  nickname: 'Summer fund',
  openingDepositMinor: 15000,
};
export const SYNTHETIC_MEMBERS: readonly Member[] = [
  { memberId: '100234', name: 'Synthetic Member Alpha', savingsBalanceMinor: 321045 },
  { memberId: '200345', name: 'Synthetic Member Beta', savingsBalanceMinor: 82902 },
  { memberId: '000001', name: 'Synthetic Member Gamma', savingsBalanceMinor: 10000 },
];
export const PRODUCTS = [
  { code: 'SAV-STD', label: 'Standard savings', minimumMinor: 2500 },
  { code: 'SAV-HY', label: 'High-yield savings', minimumMinor: 10000 },
] as const;

export function decimalMoney(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Invalid minor units');
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** Parsing is deliberately independent of the automation runtime's money parser. */
export function parseDeposit(value: string): number | null {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole = '', fraction = ''] = value.trim().split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor <= 10_000_000 ? minor : null;
}
