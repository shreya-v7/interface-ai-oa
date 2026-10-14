import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** USD per million tokens for one model. */
export interface Rates {
  inputPerMillion: number;
  outputPerMillion: number;
}
/** The original (gpt-6.1-sol) rates; kept as the default for existing callers. */
const DEFAULT_RATES: Rates = { inputPerMillion: 2.2, outputPerMillion: 11 };
const cost = (input: number, output: number, rates: Rates) =>
  (input * rates.inputPerMillion + output * rates.outputPerMillion) / 1e6;
interface Charge {
  id: string;
  reservedUsd: number;
  actualUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  status: 'reserved' | 'settled';
}
interface Ledger {
  version: 1;
  limitUsd: number;
  charges: Charge[];
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
/**
 * Exclusive lock file holding the owner's PID. A lock left by a crashed process is
 * removed once; a lock held by a live process still refuses, so two discoveries
 * never interleave ledger updates.
 */
async function acquireLock(lock: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
      if (attempt > 0 || (Number.isSafeInteger(owner) && owner > 0 && processAlive(owner)))
        throw new Error('BUDGET_LEDGER_LOCKED');
      await unlink(lock).catch(() => {});
    }
  }
  throw new Error('BUDGET_LEDGER_LOCKED');
}
export class Budget {
  constructor(
    readonly path = '.runs/model-budget.json',
    readonly limitUsd = 3,
  ) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 3)
      throw new Error('BUDGET_LIMIT_MUST_BE_AT_MOST_3_USD');
  }
  private async update<T>(fn: (ledger: Ledger) => T): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    await acquireLock(lock);
    try {
      const ledger: Ledger = JSON.parse(
        await readFile(this.path, 'utf8').catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return JSON.stringify({ version: 1, limitUsd: this.limitUsd, charges: [] });
        }),
      );
      if (ledger.version !== 1 || !Array.isArray(ledger.charges))
        throw new Error('INVALID_BUDGET_LEDGER');
      ledger.limitUsd = Math.min(ledger.limitUsd, this.limitUsd);
      const result = fn(ledger);
      const temp = `${this.path}.tmp`;
      await writeFile(temp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
      await rename(temp, this.path);
      return result;
    } finally {
      await unlink(lock);
    }
  }
  async reserve(
    inputBound: number,
    outputBound: number,
    rates: Rates = DEFAULT_RATES,
  ): Promise<string> {
    return this.update((ledger) => {
      const reservedUsd = cost(inputBound, outputBound, rates);
      const used = ledger.charges.reduce((s, c) => s + (c.actualUsd ?? c.reservedUsd), 0);
      if (used + reservedUsd > ledger.limitUsd) throw new Error('MODEL_BUDGET_EXHAUSTED');
      const id = randomUUID();
      ledger.charges.push({ id, reservedUsd, status: 'reserved' });
      return id;
    });
  }
  async settle(
    id: string,
    inputTokens: number,
    outputTokens: number,
    rates: Rates = DEFAULT_RATES,
  ): Promise<number> {
    return this.update((ledger) => {
      const charge = ledger.charges.find((c) => c.id === id);
      if (!charge) throw new Error('UNKNOWN_BUDGET_RESERVATION');
      if (
        !Number.isSafeInteger(inputTokens) ||
        !Number.isSafeInteger(outputTokens) ||
        inputTokens < 0 ||
        outputTokens < 0
      )
        throw new Error('INVALID_PROVIDER_USAGE');
      const actualUsd = cost(inputTokens, outputTokens, rates);
      if (actualUsd > charge.reservedUsd) throw new Error('PROVIDER_USAGE_EXCEEDED_RESERVATION');
      Object.assign(charge, { actualUsd, inputTokens, outputTokens, status: 'settled' });
      return actualUsd;
    });
  }
}
