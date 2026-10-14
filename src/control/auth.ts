import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PrincipalSchema, type Principal } from './access.js';

export const OPERATOR_KEY_PATH = '.runs/operator-key';
export const OPERATOR_COOKIE = 'capability_operator';
export const OPERATOR_SESSION_MS = 15 * 60_000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_ATTEMPTS = 5;
const MAX_SESSIONS = 8;

function validateToken(token: string): string {
  if (token.length < 32 || token.length > 4096 || /\s/.test(token))
    throw new Error('OPERATOR_TOKEN_INVALID: use at least 32 non-whitespace characters');
  return token;
}

/** The key stays on this machine. It is never included in console HTML or URLs. */
export async function initializeOperatorCredential(
  options: {
    path?: string;
    envToken?: string;
  } = {},
): Promise<{ token: string; path?: string; created: boolean }> {
  const configured = options.envToken ?? process.env.OPERATOR_TOKEN;
  if (configured !== undefined) return { token: validateToken(configured), created: false };
  const path = options.path ?? OPERATOR_KEY_PATH;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const token = randomBytes(32).toString('hex');
      await file.writeFile(`${token}\n`);
      await file.sync();
      return { token, path, created: true };
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4097 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('OPERATOR_KEY_PERMISSIONS: require an owner-only regular file');
    return { token: validateToken((await file.readFile('utf8')).trim()), path, created: false };
  } finally {
    await file.close();
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** One local operator principal, bounded attempts, revocable opaque sessions. */
export class OperatorAuth {
  private readonly credential: Buffer | undefined;
  private readonly sessions = new Map<string, { expiresAt: number; principal?: Principal }>();
  private failures = 0;
  private windowStarted = 0;

  constructor(
    token: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.credential = token === undefined ? undefined : digest(validateToken(token));
  }

  login(
    token: unknown,
    principal?: Principal,
  ): { session: string } | { error: 'AUTH_REJECTED' | 'LOGIN_RATE_LIMITED' } {
    const now = this.now();
    if (now - this.windowStarted >= LOGIN_WINDOW_MS) {
      this.failures = 0;
      this.windowStarted = now;
    }
    if (this.failures >= LOGIN_ATTEMPTS) return { error: 'LOGIN_RATE_LIMITED' };
    if (
      typeof token !== 'string' ||
      !this.credential ||
      token.length > 4096 ||
      !timingSafeEqual(digest(token), this.credential)
    ) {
      this.failures++;
      return { error: 'AUTH_REJECTED' };
    }
    this.failures = 0;
    return this.issue(principal);
  }

  issue(principal?: Principal): { session: string } {
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS)
      this.sessions.delete(this.sessions.keys().next().value!);
    const session = randomBytes(32).toString('hex');
    this.sessions.set(digest(session).toString('hex'), {
      expiresAt: this.now() + OPERATOR_SESSION_MS,
      ...(principal ? { principal: PrincipalSchema.parse(principal) } : {}),
    });
    return { session };
  }

  authenticate(cookie: string | undefined): string | undefined {
    const values = (cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${OPERATOR_COOKIE}=`));
    if (values.length !== 1) return undefined;
    const value = values[0]!.slice(OPERATOR_COOKIE.length + 1);
    if (!/^[a-f0-9]{64}$/.test(value)) return undefined;
    const key = digest(value).toString('hex');
    return this.active(key) ? key : undefined;
  }

  active(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (session === undefined) return false;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionKey);
      return false;
    }
    return true;
  }
  principal(sessionKey: string): Principal | undefined {
    if (!this.active(sessionKey)) return undefined;
    const principal = this.sessions.get(sessionKey)?.principal;
    return principal ? structuredClone(principal) : undefined;
  }

  revoke(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
  clear(): void {
    this.sessions.clear();
  }
  private prune(): void {
    for (const key of this.sessions.keys()) this.active(key);
  }
}

export function sessionCookie(value: string, clear = false): string {
  // Bound to loopback HTTP. A hosted deployment must use TLS and Secure cookies.
  return `${OPERATOR_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : OPERATOR_SESSION_MS / 1000}`;
}

// Remove the previous cookie path so an upgrade cannot leave two competing values.
export const expiredLegacySessionCookie = `${OPERATOR_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`;
