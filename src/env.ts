/**
 * Environment configuration.
 *
 * Every value the app depends on is read and checked here, once, at startup.
 * Anything missing — or still set to the `.env.example` placeholder — aborts
 * the process with an actionable message. The alternative (falling back to a
 * baked-in default) means a misconfigured deploy boots looking healthy while
 * signing tokens with a secret that is public in the repo.
 */

const PLACEHOLDERS = [
  'your-tvdb-api-key',
  'libsql://your-database.turso.io',
  'your-turso-auth-token',
];

/** Below this, a signing secret is worth brute-forcing. Warned about, not fatal. */
const MIN_RECOMMENDED_SECRET_LENGTH = 32;

const problems: string[] = [];
const warnings: string[] = [];

/** Required, and not left as the value shipped in .env.example. */
function read(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    problems.push(`${name} is not set`);
    return '';
  }
  if (PLACEHOLDERS.includes(value)) {
    problems.push(`${name} is still set to the .env.example placeholder`);
    return '';
  }
  return value;
}

/** Required, with no opinion on its contents beyond being set. */
function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) problems.push(`${name} is not set`);
  return value ?? '';
}

/**
 * Where the database lives.
 *
 * `DATABASE_URL` is the canonical name. `TURSO_DATABASE_URL` is still read so
 * deploys predating the rename keep working without a config change.
 *
 * A `file:` URL runs against a plain local SQLite file — no cloud account and
 * no auth token — which is what self-hosting defaults to. A `libsql://` URL
 * points at Turso (or any libsql server) and does need a token.
 */
function readDatabaseUrl(): string {
  const value = (process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL)?.trim();

  if (!value) {
    problems.push('DATABASE_URL is not set');
    return '';
  }
  if (PLACEHOLDERS.includes(value)) {
    problems.push('DATABASE_URL is still set to the .env.example placeholder');
    return '';
  }
  return value;
}

const databaseUrl = readDatabaseUrl();

/** Anything not addressed as a local file has to be authenticated to. */
const isRemoteDatabase = /^(libsql|wss?|https?):/i.test(databaseUrl);

function readDatabaseAuthToken(): string | undefined {
  const value = (process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN)?.trim();

  // A local SQLite file has nothing to authenticate against, so an unset token
  // is the expected case rather than a misconfiguration.
  if (!isRemoteDatabase) return undefined;

  if (!value) {
    problems.push('DATABASE_AUTH_TOKEN is required when DATABASE_URL is remote');
    return undefined;
  }
  if (PLACEHOLDERS.includes(value)) {
    problems.push('DATABASE_AUTH_TOKEN is still set to the .env.example placeholder');
    return undefined;
  }
  return value;
}

const jwtSecret = readRequired('JWT_SECRET');
if (jwtSecret && jwtSecret.length < MIN_RECOMMENDED_SECRET_LENGTH) {
  warnings.push(
    `JWT_SECRET is only ${jwtSecret.length} characters. Anyone who guesses it can mint ` +
      `valid tokens for any account — use at least ${MIN_RECOMMENDED_SECRET_LENGTH} random ` +
      `characters (\`openssl rand -base64 32\`).`
  );
}

export const env = {
  // Whatever you put here is the signing key — there is deliberately no
  // fallback, so a deploy that forgot to set it fails instead of signing
  // tokens with a default that is public in this repo.
  jwtSecret,
  tvdbKey: read('TVDB_KEY'),

  databaseUrl,
  databaseAuthToken: readDatabaseAuthToken(),
  isRemoteDatabase,

  /** Allowed CORS origins — comma-separated, so staging and prod can share a build. */
  origins: read('ORIGIN')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  port: Number(process.env.PORT) || 3007,
  isProduction: process.env.NODE_ENV === 'production',
};

if (problems.length > 0) {
  console.error(
    [
      '',
      'Cannot start: the environment is not configured correctly.',
      '',
      ...problems.map((p) => `  - ${p}`),
      '',
      'Set these in .env (local) or in your host\'s environment (deployed).',
      'See .env.example for the full list.',
      '',
    ].join('\n')
  );
  process.exit(1);
}

for (const warning of warnings) {
  console.warn(`Warning: ${warning}`);
}
