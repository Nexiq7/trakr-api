import { env } from './env';
import { logger } from './logger';
import * as tvdb from './tvdb';

/**
 * Trending and popular lists from TMDB, resolved to TVDB titles.
 *
 * TVDB has no trending or popularity data of its own — the old lists were its
 * `score`, which tracks activity on TVDB's site rather than what people watch.
 * TMDB's trending and popularity figures are built from real audience
 * activity, so the lists come from there. Everything else stays on TVDB: each
 * TMDB title is mapped to its TVDB id, which is what details pages and the
 * collection are keyed by, and titles that can't be mapped are left out.
 *
 * All of this is optional. Without `TMDB_KEY` the API serves the TVDB-based
 * lists exactly as before.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/original';
const REQUEST_TIMEOUT_MS = 10_000;

const LIST_TTL_MS = 30 * 60 * 1000;
/**
 * Long enough that a title is resolved only every few days, short enough that
 * one TVDB adds later starts appearing without a restart.
 */
const MAPPING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const GENRES_TTL_MS = 24 * 60 * 60 * 1000;

/** TMDB serves 20 results a page; five pages is the useful head of a list. */
const LIST_PAGES = 5;
/**
 * Trending has no genre filter, so a genre view filters a longer run of it.
 * Ten pages keeps a narrow genre from coming back nearly empty.
 */
const FILTERED_TRENDING_PAGES = 10;

/**
 * A title needs votes before its popularity figure means much.
 *
 * TV needs far more than movies. TMDB's TV popularity rewards sheer episode
 * count, so with a low bar the list filled with decades-long children's and
 * franchise shows — Sesame Street, Kamen Rider, Doraemon — on a few hundred
 * votes each. At 500 they drop out and the list is shows people actually
 * binge. Movies keep a low bar so this month's releases, which haven't
 * gathered many votes yet, still make it in.
 */
const MIN_VOTES: Record<TmdbType, number> = { movie: 100, tv: 500 };

const configured = Boolean(env.tmdbKey);

/**
 * Set when TMDB rejects the key. That is a configuration problem, not a blip:
 * retrying on every request would add a failed round trip and a log line to
 * each one, so TMDB is switched off until the process restarts with a new key.
 */
let rejected = false;

/** Whether lists should be asked of TMDB at all. */
export function isEnabled() {
  return configured && !rejected;
}

type ApiType = 'series' | 'movies';
type TmdbType = 'tv' | 'movie';

const tmdbType = (type: ApiType): TmdbType => (type === 'movies' ? 'movie' : 'tv');

/** The shape the web client already renders for a list item. */
export interface CatalogItem {
  id: number;
  name: string;
  year?: string;
  image?: string;
  overview?: string;
  score?: number;
}

interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
  genre_ids?: number[];
}

// --- HTTP ------------------------------------------------------------------

const MAX_RETRIES = 3;

let rateLimited = 0;

function send(url: string, headers: Record<string, string>) {
  return fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then((res) => {
    if (res.status === 429) rateLimited += 1;
    return res;
  });
}

/** How many times TMDB has rate-limited this process — for diagnostics. */
export function rateLimitCount() {
  return rateLimited;
}

async function tmdbJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams({ language: 'en-US', ...params });
  const headers: Record<string, string> = { Accept: 'application/json' };

  // TMDB hands out two credentials: a v3 API key, passed as a query parameter,
  // and a v4 read access token, sent as a bearer token. Either works for these
  // endpoints; the token is a JWT, which is how the two are told apart.
  if (env.tmdbKey.startsWith('eyJ')) headers.Authorization = `Bearer ${env.tmdbKey}`;
  else query.set('api_key', env.tmdbKey);

  let res = await send(`${TMDB_BASE}${path}?${query}`, headers);

  // A cold list fires a burst of lookups, which TMDB can answer with 429. A
  // lookup that gives up drops its title from a list cached for half an hour,
  // so wait out the limit (TMDB says how long) and try again.
  for (let attempt = 1; res.status === 429 && attempt <= MAX_RETRIES; attempt += 1) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5000)));
    res = await send(`${TMDB_BASE}${path}?${query}`, headers);
  }

  if (res.status === 401 && !rejected) {
    rejected = true;
    logger.error('TMDB rejected TMDB_KEY; serving TVDB lists until restart', { path });
  }
  if (!res.ok) throw new Error(`TMDB ${path} failed with status ${res.status}`);
  return (await res.json()) as T;
}

/** Run at most `max` tasks at once — TMDB rate-limits bursts. */
function limit(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

// 16 at once roughly halves a cold genre list against 8, and stays inside
// TMDB's rate limit in practice; the 429 retry above covers the edges.
const lookups = limit(16);

// --- TMDB id -> TVDB id ----------------------------------------------------

/**
 * The TVDB id for a TMDB title, or null when TVDB doesn't have it.
 *
 * Series carry their TVDB id in TMDB's external ids. Movies don't, so they go
 * through IMDb: TMDB supplies the IMDb id and TVDB is searched by it.
 *
 * A definite miss (no id anywhere) is cached like a hit, so an unmappable title
 * isn't looked up on every request. A failed request throws instead and is
 * never cached, so an outage can't mark a list's worth of titles unmappable.
 */
function tvdbIdFor(type: TmdbType, tmdbId: number): Promise<number | null> {
  return tvdb.cached(`tmdb-map:${type}:${tmdbId}`, MAPPING_TTL_MS, () =>
    lookups(async () => {
      const ids = await tmdbJson<{ tvdb_id?: number | null; imdb_id?: string | null }>(
        `/${type}/${tmdbId}/external_ids`,
      );

      if (type === 'tv' && ids.tvdb_id) return ids.tvdb_id;
      if (!ids.imdb_id) return null;

      const matches = await tvdb.findByImdbId(ids.imdb_id);
      const match = matches.find((entry) => (type === 'movie' ? entry.movie : entry.series));
      return (type === 'movie' ? match?.movie?.id : match?.series?.id) ?? null;
    }),
  );
}

async function resolve(type: TmdbType, items: TmdbListItem[]): Promise<CatalogItem[]> {
  const ids = await Promise.all(
    items.map((item) =>
      tvdbIdFor(type, item.id).catch((error) => {
        logger.warn('tmdb mapping failed', {
          type,
          tmdbId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    ),
  );

  const seen = new Set<number>();
  const resolved: CatalogItem[] = [];

  items.forEach((item, index) => {
    const id = ids[index];
    // Two TMDB entries can point at one TVDB title; the first (higher-ranked)
    // one wins so the list never shows a title twice. Titles without a poster
    // are dropped too: in a rail of artwork they read as broken cards.
    if (id == null || seen.has(id) || !item.poster_path) return;
    seen.add(id);

    const date = item.release_date || item.first_air_date;
    resolved.push({
      id,
      name: item.title ?? item.name ?? '',
      year: date ? date.slice(0, 4) : undefined,
      image: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : undefined,
      overview: item.overview || undefined,
      score: item.popularity,
    });
  });

  return resolved;
}

// --- Genres ----------------------------------------------------------------
// The web client filters by TVDB genre ids. TMDB has its own genres, so they
// are matched by name — with the handful of renames TMDB uses. A TVDB genre
// with no TMDB counterpart (Anime, Food, Game Show…) returns null, and the
// route falls back to the TVDB list for it rather than guessing.

const GENRE_ALIASES: Record<TmdbType, Record<string, string>> = {
  movie: {
    musical: 'music',
  },
  tv: {
    action: 'action & adventure',
    adventure: 'action & adventure',
    'science fiction': 'sci-fi & fantasy',
    fantasy: 'sci-fi & fantasy',
    war: 'war & politics',
    children: 'kids',
    'talk show': 'talk',
  },
};

function tmdbGenres(type: TmdbType) {
  return tvdb.cached(`tmdb-genres:${type}`, GENRES_TTL_MS, async () => {
    const json = await tmdbJson<{ genres?: { id: number; name: string }[] }>(`/genre/${type}/list`);
    return new Map((json.genres ?? []).map((genre) => [genre.name.toLowerCase(), genre.id]));
  });
}

/** Thrown when a requested genre has no TMDB equivalent, so TVDB serves it. */
export class UnmappedGenre extends Error {
  constructor() {
    super('genre has no TMDB equivalent');
    this.name = 'UnmappedGenre';
  }
}

/** TMDB genre ids for TVDB genre ids, or null if any has no TMDB equivalent. */
export async function mapGenres(type: ApiType, tvdbGenreIds: string[]): Promise<number[] | null> {
  if (tvdbGenreIds.length === 0) return [];

  const kind = tmdbType(type);
  const [tvdbList, tmdbByName] = await Promise.all([tvdb.genres(), tmdbGenres(kind)]);
  const tvdbNames = new Map(
    (tvdbList as { id: number; name: string }[]).map((genre) => [String(genre.id), genre.name.toLowerCase()]),
  );

  const mapped: number[] = [];
  for (const id of tvdbGenreIds) {
    const name = tvdbNames.get(id);
    if (!name) return null;
    const tmdbId = tmdbByName.get(GENRE_ALIASES[kind][name] ?? name);
    if (tmdbId == null) return null;
    if (!mapped.includes(tmdbId)) mapped.push(tmdbId);
  }
  return mapped;
}

// --- Lists -----------------------------------------------------------------

/**
 * Talk and news shows top TMDB's TV charts week after week without being
 * anything anyone tracks. Soaps join them for "popular", where decades of daily
 * episodes give them an outsized popularity figure.
 */
const TV_TALK = 10767;
const TV_NEWS = 10763;
const TV_SOAP = 10766;

/**
 * The deepest page Discover will scroll to. TMDB serves up to 500, but past a
 * few hundred titles a popularity-ordered list is noise, and each page costs a
 * round of TVDB lookups.
 */
const MAX_PAGES = 25;

export type ListName = 'trending' | 'popular';

export interface CatalogPage {
  data: CatalogItem[];
  page: number;
  hasMore: boolean;
}

const genreKey = (genres: number[]) => [...genres].sort((a, b) => a - b).join(',');

interface ListSpec {
  path: string;
  params: Record<string, string>;
  /** Filtering TMDB can't do server-side, applied to each page. */
  keep: (item: TmdbListItem) => boolean;
  /** How many pages the unpaged list — the home page rails — is built from. */
  fullPages: number;
}

function specFor(list: ListName, kind: TmdbType, genres: number[]): ListSpec {
  if (list === 'trending') {
    // Trending has no genre filter, so genres are matched per item, and the
    // unpaged list reads further into the chart to find enough of them.
    const excluded = kind === 'tv' ? [TV_TALK, TV_NEWS] : [];
    return {
      path: `/trending/${kind}/week`,
      params: {},
      keep: (item) => {
        const itemGenres = item.genre_ids ?? [];
        if (itemGenres.some((genre) => excluded.includes(genre))) return false;
        return genres.every((genre) => itemGenres.includes(genre));
      },
      fullPages: genres.length > 0 ? FILTERED_TRENDING_PAGES : LIST_PAGES,
    };
  }

  const params: Record<string, string> = {
    sort_by: 'popularity.desc',
    include_adult: 'false',
  };
  // A comma in `with_genres` means "all of these", matching the web client.
  if (genres.length > 0) params.with_genres = genres.join(',');
  if (kind === 'tv') params.without_genres = [TV_TALK, TV_NEWS, TV_SOAP].join('|');
  if (kind === 'movie') params.include_video = 'false';
  params['vote_count.gte'] = String(MIN_VOTES[kind]);

  return { path: `/discover/${kind}`, params, keep: () => true, fullPages: LIST_PAGES };
}

/**
 * One page of a list, resolved to TVDB titles.
 *
 * A page maps to exactly one TMDB page, so it carries as many titles as
 * survive filtering and TVDB lookup — usually most of 20, occasionally a
 * handful for a narrow genre on trending. The client keeps paging while its
 * scroll sentinel is visible, so a thin page just means another request.
 */
export function listPage(
  list: ListName,
  type: ApiType,
  genres: number[],
  page: number,
  { force = false } = {},
): Promise<CatalogPage> {
  const kind = tmdbType(type);
  const key = `tmdb:${list}:${kind}:${genreKey(genres)}:p${page}`;

  return (force ? tvdb.refresh : tvdb.cached)(key, LIST_TTL_MS, async () => {
    const spec = specFor(list, kind, genres);
    const json = await tmdbJson<{ results?: TmdbListItem[]; total_pages?: number }>(spec.path, {
      ...spec.params,
      page: String(page),
    });

    return {
      data: await resolve(kind, (json.results ?? []).filter(spec.keep)),
      page,
      hasMore: page < Math.min(json.total_pages ?? 0, MAX_PAGES),
    };
  });
}

/**
 * The head of a list as one array, for the home page's rails.
 *
 * Built from the same cached pages Discover scrolls through, so warming the
 * home page warms the first pages of Discover too.
 */
function fullList(list: ListName, type: ApiType, genres: number[], force: boolean) {
  const kind = tmdbType(type);
  const key = `tmdb:${list}:${kind}:${genreKey(genres)}`;

  return (force ? tvdb.refresh : tvdb.cached)(key, LIST_TTL_MS, async () => {
    const spec = specFor(list, kind, genres);
    const pages = await Promise.all(
      Array.from({ length: spec.fullPages }, (_, index) =>
        listPage(list, type, genres, index + 1, { force }).catch((error) => {
          // A later page failing shouldn't sink the ones that loaded.
          if (index === 0) throw error;
          return null;
        }),
      ),
    );

    // TMDB's ordering shifts between page requests, so a title can land on two
    // pages; the first appearance wins.
    const seen = new Set<number>();
    const items: CatalogItem[] = [];
    for (const page of pages) {
      for (const item of page?.data ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return items;
  });
}

/** What's trending this week, optionally narrowed to genres (all must match). */
export function trending(type: ApiType, genres: number[] = [], { force = false } = {}) {
  return fullList('trending', type, genres, force);
}

/** The most popular titles right now, optionally narrowed to genres. */
export function popular(type: ApiType, genres: number[] = [], { force = false } = {}) {
  return fullList('popular', type, genres, force);
}

// --- Warming ---------------------------------------------------------------

/** Just under the list TTL, so the home page's lists never expire under a reader. */
const WARM_INTERVAL_MS = 25 * 60 * 1000;

/**
 * Keep the lists the home page opens with warm.
 *
 * A cold list costs one TVDB lookup per title — a few seconds the first time.
 * Refreshing on a timer means that cost is paid in the background instead of
 * by whoever happens to load the home page after the cache expires.
 */
export function startWarming() {
  if (!isEnabled()) return;

  const warm = async () => {
    if (!isEnabled()) return;
    const started = Date.now();
    // Refreshed in place: readers keep getting the previous list until the new
    // one is ready, so there is never a moment with nothing cached.
    const lists: [string, () => Promise<CatalogItem[]>][] = [
      ['trending series', () => trending('series', [], { force: true })],
      ['trending movies', () => trending('movies', [], { force: true })],
      ['popular series', () => popular('series', [], { force: true })],
      ['popular movies', () => popular('movies', [], { force: true })],
    ];

    let failed = 0;
    for (const [name, load] of lists) {
      if (!isEnabled()) return;
      try {
        await load();
      } catch (error) {
        failed += 1;
        logger.warn('tmdb warm failed', {
          list: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failed < lists.length) {
      logger.info('tmdb lists warmed', { durationMs: Date.now() - started, failed });
    }
  };

  void warm();
  setInterval(warm, WARM_INTERVAL_MS).unref?.();
}
