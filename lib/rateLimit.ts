// Per-IP fixed-window rate limiting for public endpoints, backed by the shared
// Redis instance. Used to stop bots from spamming the public website form —
// each accepted submission can trigger a (paid) outbound AI call.
//
// Design notes:
// - Fixed window via INCR + EXPIRE: cheap, atomic-enough, no Lua needed.
// - FAILS OPEN: if Redis is unreachable we allow the request. Lead intake is
//   revenue-critical, so a Redis outage must not silently drop real leads.
//   (Rate limiting is a hardening layer; auth/honeypot are the real controls.)
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  limit: number;
  resetSeconds: number;
};

/// Increment the counter for `key` and report whether it's within `limit`
/// over a rolling `windowSeconds` window.
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redisKey = `rl:${key}`;
  try {
    const count = await redis.incr(redisKey);
    // First hit in this window — set the TTL so the counter resets.
    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    }
    let ttl = windowSeconds;
    if (count > 1) {
      const t = await redis.ttl(redisKey);
      // -1 (no expiry) / -2 (missing) shouldn't happen, but guard anyway.
      ttl = t >= 0 ? t : windowSeconds;
    }
    return {
      ok: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      resetSeconds: ttl,
    };
  } catch (err) {
    logger.error(`Rate limit check failed for ${redisKey} (allowing request): ${String(err)}`);
    return { ok: true, remaining: limit, limit, resetSeconds: windowSeconds };
  }
}

/// Best-effort client IP from proxy headers (Railway/Vercel set x-forwarded-for).
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
