import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';

/**
 * Fixed-window rate limiting, keyed by client IP.
 *
 * State lives in memory, which is the right trade-off for a single-container
 * deploy: no extra infrastructure, and a restart only forgives in-flight
 * offenders. Running more than one backend replica would need a shared store
 * (Redis) instead, since each replica would otherwise keep its own counts.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_CLIENTS = 10_000;

function clientKey(c: Context): string {
  // Behind Dokploy/Traefik the real client address is only in X-Forwarded-For.
  // The left-most entry is the originating client.
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();

  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Drop expired buckets so a stream of unique IPs can't grow the map forever. */
function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimit(opts: { name: string; windowMs: number; max: number; message?: string }): MiddlewareHandler {
  const { name, windowMs, max, message = 'Too many requests. Please try again shortly.' } = opts;

  return async (c, next) => {
    const now = Date.now();
    if (buckets.size > MAX_TRACKED_CLIENTS) sweep(now);

    const key = `${name}:${clientKey(c)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: message }, 429);
    }

    bucket.count++;
    return next();
  };
}
