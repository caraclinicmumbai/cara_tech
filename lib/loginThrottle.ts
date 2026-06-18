// Brute-force protection for credentials login, backed by the shared Redis.
//
// Counts FAILED attempts per client IP and locks further attempts once the
// threshold is hit within the window. Successful logins clear the counter, so
// legitimate users are never penalised for the occasional typo.
//
// Keyed by IP (not email) on purpose: email-keyed lockout would let an attacker
// lock a victim out of their own account from anywhere. IP-keyed stops the
// common single-source brute force without that DoS vector.
//
// FAILS OPEN: a Redis outage must not lock everyone out of the CRM.
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

export const MAX_LOGIN_FAILURES = 10; // per window, per IP
export const LOGIN_WINDOW_SECONDS = 15 * 60; // 15 minutes
const KEY_PREFIX = "login-fail:";

export type LockState = { locked: boolean; retrySeconds: number };

/// Is this client currently locked out? (does not increment)
export async function isLoginLocked(id: string): Promise<LockState> {
  try {
    const key = KEY_PREFIX + id;
    const raw = await redis.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= MAX_LOGIN_FAILURES) {
      const ttl = await redis.ttl(key);
      return { locked: true, retrySeconds: ttl >= 0 ? ttl : LOGIN_WINDOW_SECONDS };
    }
    return { locked: false, retrySeconds: 0 };
  } catch (err) {
    logger.error(`Login lock check failed (allowing): ${String(err)}`);
    return { locked: false, retrySeconds: 0 };
  }
}

/// Record a failed attempt; sets the window TTL on the first failure.
export async function recordLoginFailure(id: string): Promise<void> {
  try {
    const key = KEY_PREFIX + id;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, LOGIN_WINDOW_SECONDS);
  } catch (err) {
    logger.error(`Recording login failure failed: ${String(err)}`);
  }
}

/// Clear the failure counter after a successful login.
export async function clearLoginFailures(id: string): Promise<void> {
  try {
    await redis.del(KEY_PREFIX + id);
  } catch {
    /* best effort — non-fatal */
  }
}
