import { HTTPException } from 'hono/http-exception';

/**
 * Request-body validation for anything that reaches the database.
 *
 * Each parser returns a narrowed, trusted value or throws an HTTPException
 * that the global error handler renders as a 400 — so routes below this layer
 * can assume their input is well-formed.
 */

const STATUSES = new Set(['watching', 'planning', 'completed', 'dropped']);
const MEDIA_TYPES = new Set(['series', 'movie']);
const MEDIA_ID_RE = /^(series|movie)-\d{1,12}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;

// bcrypt only reads the first 72 bytes of a password; anything longer is
// silently ignored, so reject it rather than accept a password whose tail
// does nothing.
const MAX_PASSWORD_BYTES = 72;

function bad(message: string): never {
  throw new HTTPException(400, { message });
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) bad('Expected a JSON object');
  return body as Record<string, unknown>;
}

/** Read and parse a JSON body, turning malformed JSON into a 400 rather than a 500. */
export async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    return asObject(await c.req.json());
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    bad('Request body must be valid JSON');
  }
}

/** Strict rules for account creation. */
export function parseSignup(body: Record<string, unknown>) {
  const username = typeof body.username === 'string' ? body.username.trim() : bad('Username is required');
  const password = typeof body.password === 'string' ? body.password : bad('Password is required');

  if (username.length < 3 || username.length > 32) bad('Username must be between 3 and 32 characters');
  if (!USERNAME_RE.test(username)) bad('Username may only contain letters, numbers, and . _ -');
  if (password.length < 8) bad('Password must be at least 8 characters');
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) bad('Password is too long');

  return { username, password };
}

/**
 * Login is deliberately lenient: the rules above are enforced at signup, and
 * re-applying them here would lock out any account created before them.
 */
export function parseLogin(body: Record<string, unknown>) {
  const username = typeof body.username === 'string' ? body.username.trim() : bad('Username is required');
  const password = typeof body.password === 'string' ? body.password : bad('Password is required');

  if (!username || !password) bad('Username and password are required');
  if (username.length > 32 || new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    bad('Invalid credentials');
  }

  return { username, password };
}

export function parseTrack(body: Record<string, unknown>) {
  const mediaId = typeof body.mediaId === 'string' ? body.mediaId.trim() : bad('mediaId is required');
  if (!MEDIA_ID_RE.test(mediaId)) bad('mediaId must look like "series-12345" or "movie-12345"');

  const type = typeof body.type === 'string' ? body.type : bad('type is required');
  if (!MEDIA_TYPES.has(type)) bad('type must be "series" or "movie"');

  // An empty status is legitimate: scoring a title before choosing a status
  // leaves it unset.
  let status: string | null = null;
  if (body.status !== undefined && body.status !== null && body.status !== '') {
    if (typeof body.status !== 'string' || !STATUSES.has(body.status)) {
      bad('status must be one of: watching, planning, completed, dropped');
    }
    status = body.status;
  }

  let score: number | null = null;
  if (body.score !== undefined && body.score !== null) {
    if (typeof body.score !== 'number' || !Number.isInteger(body.score) || body.score < 0 || body.score > 10) {
      bad('score must be a whole number between 0 and 10');
    }
    score = body.score;
  }

  return { mediaId, type, status, score };
}

/** Path params reach TVDB's URL, so keep them to the shapes TVDB actually accepts. */
export function parseMediaType(type: string): 'series' | 'movies' {
  if (type === 'series' || type === 'movies') return type;
  bad('type must be "series" or "movies"');
}

export function parseTvdbId(id: string): string {
  if (!/^\d{1,12}$/.test(id)) bad('id must be numeric');
  return id;
}

const SORTS = new Set(['score', 'firstAired', 'name']);
const SORT_TYPES = new Set(['asc', 'desc']);
const MAX_GENRES = 10;

export function parseSort(value: string | undefined): string {
  if (!value) return 'score';
  if (!SORTS.has(value)) bad('sort must be one of: score, firstAired, name');
  return value;
}

export function parseSortType(value: string | undefined): string {
  if (!value) return 'desc';
  if (!SORT_TYPES.has(value)) bad('sortType must be "asc" or "desc"');
  return value;
}

/** Comma-separated TVDB genre ids, e.g. "1,6". */
export function parseGenreIds(value: string | undefined): string[] {
  if (!value) return [];

  const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length > MAX_GENRES) bad(`No more than ${MAX_GENRES} genres may be selected`);
  if (ids.some((id) => !/^\d{1,6}$/.test(id))) bad('genre ids must be numeric');

  return ids;
}

const MAX_QUERY_LENGTH = 100;

export function parseSearchQuery(value: string | undefined): string {
  const query = value?.trim();
  if (!query) bad('Search query is required');
  if (query.length > MAX_QUERY_LENGTH) bad('Search query is too long');
  return query;
}
