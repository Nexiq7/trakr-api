import type { MiddlewareHandler } from 'hono';
import { getClientIp } from './ip';
import { logger } from './logger';

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

    const ip = getClientIp(c);
    const key = `${name}:${ip}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      logger.warn('rate limit exceeded', { limiter: name, ip, path: c.req.path });
      return c.json({ error: message }, 429);
    }

    bucket.count++;
    return next();
  };
}
