import { env } from './env';

/**
 * TVDB v4 client: token lifecycle, response caching, and the English-preferring
 * lookups the UI depends on.
 */

const TVDB_BASE = 'https://api4.thetvdb.com/v4';
const REQUEST_TIMEOUT_MS = 10_000;

// --- Auth token ------------------------------------------------------------
// TVDB tokens are valid for ~30 days. The previous implementation cached one
// forever in a module variable, so once it expired every TVDB-backed route
// failed until the process was restarted. Track the expiry, and treat a 401 as
// authoritative proof the token is dead regardless of what we think it is.

let token: { value: string; expiresAt: number } | null = null;
let loginInFlight: Promise<string> | null = null;

const TOKEN_TTL_MS = 29 * 24 * 60 * 60 * 1000; // refresh a day before TVDB expires it

async function login(): Promise<string> {
  const res = await fetch(`${TVDB_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: env.tvdbKey }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`TVDB login failed with status ${res.status}`);

  const { data } = (await res.json()) as { data?: { token?: string } };
  if (!data?.token) throw new Error('TVDB login returned no token');

  token = { value: data.token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return data.token;
}

async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && token && token.expiresAt > Date.now()) return token.value;

  // Collapse concurrent refreshes into one login request.
  if (!loginInFlight) {
    loginInFlight = login().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

/** Call a TVDB endpoint, re-authenticating once if the token was rejected. */
async function tvdbFetch(path: string): Promise<Response> {
  const send = async (bearer: string) =>
    fetch(`${TVDB_BASE}${path}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let res = await send(await getToken());
  if (res.status === 401) {
    token = null;
    res = await send(await getToken(true));
  }
  return res;
}

/** Fetch and parse JSON, throwing on error responses so failures are never cached. */
async function tvdbJson<T = any>(path: string): Promise<T> {
  const res = await tvdbFetch(path);
  if (!res.ok) throw new Error(`TVDB ${path} failed with status ${res.status}`);
  return (await res.json()) as T;
}

// --- Response cache --------------------------------------------------------
// Keeps repeat loads fast and keeps us inside TVDB's rate limits. Bounded,
// because part of the key space (`search:<query>`) is user-controlled and an
// unbounded map is a memory-exhaustion vector.

type Entry = { data: any; expiresAt: number };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<any>>();
const MAX_CACHE_ENTRIES = 2_000;

function evictIfNeeded() {
  if (cache.size <= MAX_CACHE_ENTRIES) return;

  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // Still oversized: drop oldest-inserted entries (Map preserves insertion order).
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;

  // Share one request between callers that all miss at the same moment,
  // instead of stampeding TVDB when a popular key expires.
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = fn()
    .then((data) => {
      cache.set(key, { data, expiresAt: Date.now() + ttlMs });
      evictIfNeeded();
      return data;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

// --- English-preferring helpers -------------------------------------------
// TVDB's default `name`/`overview` is whichever language the record was
// originally entered in (often Korean/Japanese/etc for non-US content).
// Only look up a translation when the default text actually looks non-English,
// so most items never need the extra request.

const NON_LATIN_RE = /[぀-ヿ㐀-鿿가-힯Ѐ-ӿ฀-๿؀-ۿ]/;

export function needsTranslation(name?: string) {
  return !!name && NON_LATIN_RE.test(name);
}

export async function getEnglishTranslation(apiType: string, id: string | number) {
  try {
    const { data } = await tvdbJson(`/${apiType}/${id}/translations/eng`);
    return data as { name?: string; overview?: string } | null;
  } catch {
    // A missing translation is normal — fall back to the original title.
    return null;
  }
}

/** Replace non-English titles in a list of TVDB records, in place. */
export async function anglicizeList(items: any[], apiType: string) {
  await Promise.all(
    items.map(async (item) => {
      if (!needsTranslation(item.name)) return;
      const translation = await getEnglishTranslation(apiType, item.id);
      if (translation?.name) item.name = translation.name;
    })
  );
}

export async function anglicizeSearchResults(items: any[]) {
  await Promise.all(
    items.map(async (item) => {
      if (!needsTranslation(item.name)) return;
      const apiType = item.type === 'movie' ? 'movies' : 'series';
      const translation = await getEnglishTranslation(apiType, item.tvdb_id);
      if (translation?.name) item.name = translation.name;
    })
  );
}

// --- Queries ---------------------------------------------------------------

export function search(query: string) {
  return cached(`search:${query.toLowerCase()}`, 5 * 60 * 1000, async () => {
    const json = await tvdbJson(`/search?query=${encodeURIComponent(query)}`);

    // Only series/movies have a details page to link to.
    const items = (json.data || []).filter((item: any) => item.type === 'series' || item.type === 'movie');
    await anglicizeSearchResults(items);

    return { ...json, data: items };
  });
}

export function popular(type: 'series' | 'movies') {
  return cached(`popular:${type}`, 30 * 60 * 1000, async () => {
    const json = await tvdbJson(`/${type}/filter?sortType=desc&sort=score`);
    const items = json.data || [];
    await anglicizeList(items, type);
    return { ...json, data: items };
  });
}

export function genres() {
  return cached('genres', 24 * 60 * 60 * 1000, async () => {
    const json = await tvdbJson('/genres');
    return json.data || [];
  });
}

export function browse(opts: {
  type: 'series' | 'movies';
  genreId?: string;
  sort: string;
  sortType: string;
  year?: number;
}) {
  const { type, genreId, sort, sortType, year } = opts;

  return cached(
    `browse:${type}:${genreId || 'all'}:${sort}:${sortType}:${year || 'any'}`,
    30 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ sort, sortType });
      if (genreId) params.set('genre', genreId);
      if (year) params.set('year', String(year));

      const json = await tvdbJson(`/${type}/filter?${params}`);

      // Cap payload size — some genres/types return thousands of records.
      const items = (json.data || []).slice(0, 240);
      await anglicizeList(items, type);
      return items;
    }
  );
}

/**
 * Full extended details for a series/movie, preferring English name + overview,
 * and (for series, when requested) an English episode list.
 */
export function getMediaDetails(apiType: string, id: string | number, opts: { episodes?: boolean } = {}) {
  const cacheKey = `details:${apiType}:${id}:${opts.episodes ? 'ep' : 'noep'}`;

  return cached(cacheKey, 30 * 60 * 1000, async () => {
    const [baseJson, translation, episodesJson] = await Promise.all([
      tvdbJson(`/${apiType}/${id}/extended`),
      getEnglishTranslation(apiType, id),
      opts.episodes && apiType === 'series'
        ? tvdbJson(`/series/${id}/episodes/default/eng?page=0`).catch(() => null)
        : Promise.resolve(null),
    ]);

    const data = baseJson?.data;
    if (data) {
      if (translation?.name) data.name = translation.name;
      if (translation?.overview) data.overview = translation.overview;
      if (episodesJson?.data?.episodes) data.episodes = episodesJson.data.episodes;
    }

    return data;
  });
}
