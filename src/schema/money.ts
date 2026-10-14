/**
 * The runtime's single money codec: integer minor units <-> "1234.56" display text.
 * The simulator (sim/fixtures.ts) and the oracle (eval/oracle.ts) keep their own
 * independent parsers on purpose, so a bug here cannot also hide in the checkers.
 */
const fail = (code: string) => Object.assign(new Error(code), { code });

export function formatMinor(minor: unknown): string {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 0)
    throw fail('INVALID_MONEY');
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export function parseMoney(text: string): number {
  const clean = text.trim().replace(/^\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(clean)) throw fail('INVALID_MONEY_OUTPUT');
  const [whole, fraction] = clean.replaceAll(',', '').split('.');
  const minor = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(minor)) throw fail('INVALID_MONEY_OUTPUT');
  return minor;
}
