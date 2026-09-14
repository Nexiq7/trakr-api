import { Hono } from 'hono';
import { jwt, sign } from 'hono/jwt';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

import { env } from './env';
import { db } from './db';
import { users, watchlist } from './db/schema';
import { rateLimit } from './rate-limit';
import { logger } from './logger';
import { getClientIp } from './ip';
import * as tvdb from './tvdb';
import * as tmdb from './tmdb';
import {
  jsonBody,
  parseSignup,
  parseLogin,
  parseTrack,
  parseMediaType,
  parseTvdbId,
  parseSort,
  parseSortType,
  parseGenreIds,
  parseSearchQuery,
  parsePage,
} from './validate';

const app = new Hono();

/** Tokens expire so a leaked one stops being useful; the SPA logs out on 401. */
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// --- GLOBAL MIDDLEWARE ---

// One line per request, after it's handled, so the status code (including
// ones `onError` produces) is known. Registered first so the timer covers
// every downstream middleware and the route handler.
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();

  const jwtPayload = c.get('jwtPayload') as { id: number } | undefined;
  logger.info('request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - start,
    ip: getClientIp(c),
    userId: jwtPayload?.id,
  });
});

app.use('*', secureHeaders());
app.use('*', bodyLimit({ maxSize: 32 * 1024 }));

app.use(
  '*',
  cors({
    origin: env.origins,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  })
);

/**
 * One place where errors become responses. Validation failures and auth
 * rejections carry their own status; everything else is logged server-side and
 * reported as a generic 500, so stack traces and driver messages never reach
 * the client.
 */
// Middleware-raised exceptions (body limit, JWT) carry a Response rather than a
// message, so fall back to something the UI can actually display.
const STATUS_FALLBACKS: Record<number, string> = {
  401: 'Unauthorized',
  413: 'Request body is too large',
};

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const message = err.message || STATUS_FALLBACKS[err.status] || 'Request failed';
    return c.json({ error: message }, err.status);
  }

  logger.error('unhandled error', {
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ error: 'Something went wrong' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// --- HEALTH ---

/** Liveness probe for Docker/Dokploy. Deliberately does not touch the database. */
app.get('/health', (c) => c.json({ status: 'ok' }));

// --- AUTH ROUTES ---

// Credential endpoints are the ones worth brute-forcing, so they get the
// tightest budget in the app.
const authLimiter = rateLimit({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many attempts. Please try again in a few minutes.',
});

function issueToken(user: { id: number; username: string }) {
  return sign(
    {
      id: user.id,
      username: user.username,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    },
    env.jwtSecret
  );
}

app.post('/auth/signup', authLimiter, async (c) => {
  const { username, password } = parseSignup(await jsonBody(c));

  const existing = await db.select().from(users).where(eq(users.username, username)).get();
  if (existing) return c.json({ error: 'Username taken' }, 409);

  const passwordHash = await bcrypt.hash(password, 10);

  let created;
  try {
    created = await db.insert(users).values({ username, passwordHash }).returning();
  } catch (e) {
    // Two signups racing for the same name: the unique index is the source of
    // truth, and the loser lands here.
    if (String(e).includes('UNIQUE')) return c.json({ error: 'Username taken' }, 409);
    throw e;
  }

  const user = created[0]!;
  logger.info('user signed up', { userId: user.id, username: user.username });
  return c.json({ token: await issueToken(user), userId: user.id }, 201);
});

app.post('/auth/login', authLimiter, async (c) => {
  const { username, password } = parseLogin(await jsonBody(c));

  const user = await db.select().from(users).where(eq(users.username, username)).get();

  // Hash even when the user doesn't exist, so response time doesn't reveal
  // which usernames are registered.
  const passwordHash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const valid = await bcrypt.compare(password, passwordHash);

  if (!user || !valid) {
    logger.warn('login failed', { username });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  logger.info('user logged in', { userId: user.id, username: user.username });
  return c.json({ token: await issueToken(user) });
});

// --- PROTECTED ROUTES ---

// Everything below requires a valid Bearer token.
app.use('/api/*', jwt({ secret: env.jwtSecret, alg: 'HS256' }));

type JwtPayload = { id: number; username: string };

app.post('/api/track', async (c) => {
  const payload = c.get('jwtPayload') as JwtPayload;
  const { mediaId, type, status, score } = parseTrack(await jsonBody(c));

  // Update in place when the row already exists so `createdAt` (and the row id)
  // survive score/status edits instead of being wiped by a delete+reinsert.
  const existing = await db
    .select()
    .from(watchlist)
    .where(and(eq(watchlist.userId, payload.id), eq(watchlist.mediaId, mediaId)))
    .get();

  if (existing) {
    const updated = await db
      .update(watchlist)
      .set({ type, status, score })
      .where(eq(watchlist.id, existing.id))
      .returning();

    logger.info('watchlist item updated', { userId: payload.id, mediaId, status, score });
    return c.json(updated[0]);
  }

  const inserted = await db
    .insert(watchlist)
    .values({ userId: payload.id, mediaId, type, score, status, createdAt: new Date() })
    .returning();

  logger.info('watchlist item added', { userId: payload.id, mediaId, type, status, score });
  return c.json(inserted[0]);
});

app.delete('/api/track/:mediaId', async (c) => {
  const payload = c.get('jwtPayload') as JwtPayload;
  const mediaId = c.req.param('mediaId');

  await db
    .delete(watchlist)
    .where(and(eq(watchlist.userId, payload.id), eq(watchlist.mediaId, mediaId)));

  logger.info('watchlist item removed', { userId: payload.id, mediaId });
  return c.json({ success: true });
});

app.get('/api/watchlist-details', async (c) => {
  const payload = c.get('jwtPayload') as JwtPayload;

  const userItems = await db.select().from(watchlist).where(eq(watchlist.userId, payload.id));

  // Fetch full (English-preferring) details for each item in parallel. A title
  // TVDB can't resolve degrades to `details: null` rather than failing the
  // whole collection.
  const detailedList = await Promise.all(
    userItems.map(async (item) => {
      const actualId = item.mediaId.includes('-') ? item.mediaId.split('-')[1]! : item.mediaId;
      const apiType = item.type === 'movie' ? 'movies' : 'series';

      const details = await tvdb.getMediaDetails(apiType, actualId).catch(() => null);
      return { ...item, details };
    })
  );

  return c.json(detailedList);
});

// --- TVDB PUBLIC ROUTES (No Auth Required for Discovery) ---

// Public, unauthenticated, and backed by our upstream API quota — so they get a
// budget generous enough for real browsing but low enough to stop scraping.
const tvdbLimiter = rateLimit({ name: 'tvdb', windowMs: 60 * 1000, max: 120 });

app.use('/tvdb/*', tvdbLimiter);

/** SEARCH: /tvdb/search?q=Breaking+Bad */
app.get('/tvdb/search', async (c) => {
  const query = parseSearchQuery(c.req.query('q'));
  return c.json(await tvdb.search(query));
});

/** DETAILS: /tvdb/details/series/80348 */
app.get('/tvdb/details/:type/:id', async (c) => {
  const type = parseMediaType(c.req.param('type'));
  const id = parseTvdbId(c.req.param('id'));

  const data = await tvdb.getMediaDetails(type, id, { episodes: true });
  return c.json({ data });
});

/**
 * A list from TMDB, or null when TMDB isn't configured, can't express the
 * request, or is failing.
 *
 * Callers fall through to the TVDB list on null, so TMDB is strictly an
 * upgrade: an outage or a missing key degrades to the old lists, never to an
 * error page.
 */
async function fromTmdb<T>(load: () => Promise<T>): Promise<T | null> {
  if (!tmdb.isEnabled()) return null;
  try {
    return await load();
  } catch (error) {
    if (error instanceof tmdb.UnmappedGenre) return null;
    logger.warn('tmdb list failed, using tvdb', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** POPULAR: /tvdb/popular/series */
app.get('/tvdb/popular/:type', async (c) => {
  const type = parseMediaType(c.req.param('type'));

  const data = await fromTmdb(() => tmdb.popular(type));
  if (data) return c.json({ data });

  return c.json(await tvdb.popular(type));
});

/** GENRES: the Discover page's filter chips. */
app.get('/tvdb/genres', async (c) => {
  return c.json({ data: await tvdb.genres() });
});

/** Titles per page for lists served from TVDB, which returns them all at once. */
const TVDB_PAGE_SIZE = 24;

/**
 * BROWSE: /tvdb/browse/series?genre=18,6&sort=score&sortType=desc
 *
 * Also `?trending=1`. Several genres mean "all of these".
 * Without `page` the whole list comes back as `{ data }` (the home page's
 * rails); with `page=N` it's `{ data, page, hasMore }`, which is what Discover
 * scrolls through.
 */
app.get('/tvdb/browse/:type', async (c) => {
  const type = parseMediaType(c.req.param('type'));
  const sort = parseSort(c.req.query('sort'));
  const sortType = parseSortType(c.req.query('sortType'));
  const genreIds = parseGenreIds(c.req.query('genre'));
  const page = parsePage(c.req.query('page'));
  const trending = c.req.query('trending') === '1';

  // Trending and most-popular are the lists TVDB can't produce honestly, so
  // they come from TMDB when every selected genre has a TMDB equivalent.
  // Newest and A-Z are plain catalog orderings and stay on TVDB.
  const popularity = trending || (sort === 'score' && sortType === 'desc');
  if (popularity) {
    const list = trending ? 'trending' : 'popular';
    const result = await fromTmdb(async () => {
      const tmdbGenreIds = await tmdb.mapGenres(type, genreIds);
      // A genre TMDB doesn't have: let TVDB answer rather than guess.
      if (tmdbGenreIds === null) throw new tmdb.UnmappedGenre();
      return page === null
        ? { data: await (trending ? tmdb.trending : tmdb.popular)(type, tmdbGenreIds) }
        : tmdb.listPage(list, type, tmdbGenreIds, page);
    });
    if (result) return c.json(result);
  }

  // TVDB's filter endpoint only accepts a single genre per request, so each
  // genre is fetched (and cached) individually and multi-select is resolved as
  // an intersection — items must match every selected genre.
  const fetchList = (genreId?: string, year?: number) =>
    tvdb.browse({ type, genreId, sort, sortType, year });

  const intersect = (lists: any[][]) => {
    const [first = [], ...rest] = lists;
    const restIdSets = rest.map((list) => new Set(list.map((item: any) => item.id)));
    return first.filter((item: any) => restIdSets.every((set) => set.has(item.id)));
  };

  const genreRuns = genreIds.length > 0 ? genreIds : [undefined];

  let data: any[];
  if (trending) {
    // TVDB has no dedicated trending endpoint — approximate it as popular
    // (score-sorted) content released/aired in the last two calendar years, so
    // it surfaces what's currently popular rather than all-time hits. TVDB's
    // `year` filter is fuzzy (occasionally returns older outliers), so the year
    // is also enforced here to keep results honest.
    const currentYear = new Date().getFullYear();
    const targetYears = new Set([String(currentYear), String(currentYear - 1)]);

    const perGenre = await Promise.all(
      genreRuns.map(async (genreId) => {
        const [thisYear, lastYear] = await Promise.all([
          fetchList(genreId, currentYear),
          fetchList(genreId, currentYear - 1),
        ]);
        const merged = new Map<string | number, any>();
        for (const item of [...thisYear, ...lastYear]) {
          if (targetYears.has(String(item.year))) merged.set(item.id, item);
        }
        return [...merged.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
      }),
    );
    data = intersect(perGenre).slice(0, 240);
  } else {
    data = intersect(await Promise.all(genreRuns.map((id) => fetchList(id))));
  }

  if (page === null) return c.json({ data });

  const start = (page - 1) * TVDB_PAGE_SIZE;
  return c.json({
    data: data.slice(start, start + TVDB_PAGE_SIZE),
    page,
    hasMore: start + TVDB_PAGE_SIZE < data.length,
  });
});

logger.info('trakr backend listening', { port: env.port, tmdb: tmdb.isEnabled() });
tmdb.startWarming();

export default {
  port: env.port,
  fetch: app.fetch,
};
