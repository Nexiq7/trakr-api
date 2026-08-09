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

const problems: string[] = [];

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

export const env = {
  // Whatever you put here is the signing key — there is deliberately no
  // fallback, so a deploy that forgot to set it fails instead of signing
  // tokens with a default that is public in this repo.
  jwtSecret: readRequired('JWT_SECRET'),
  tvdbKey: read('TVDB_KEY'),
  tursoUrl: read('TURSO_DATABASE_URL'),
  tursoAuthToken: read('TURSO_AUTH_TOKEN'),

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
      'Set these in backend/.env (local) or in your host\'s environment (deployed).',
      'See backend/.env.example for the full list.',
      '',
    ].join('\n')
  );
  process.exit(1);
}
