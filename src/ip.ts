import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

/**
 * Behind Dokploy/Traefik the real client address is only in X-Forwarded-For.
 * The left-most entry is the originating client.
 */
export function getClientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();

  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
