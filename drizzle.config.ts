import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '.env' });

// Mirrors src/env.ts: DATABASE_URL is canonical, TURSO_DATABASE_URL is kept for
// deploys that predate the rename.
const url = (process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL ?? '').trim();
const authToken = (process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN ?? '').trim();
const isRemote = /^(libsql|wss?|https?):/i.test(url);

// A local file is plain SQLite; only a remote libsql server needs the `turso`
// dialect and a token.
export default defineConfig(
  isRemote
    ? {
        schema: './src/db/schema.ts',
        out: './migrations',
        dialect: 'turso',
        dbCredentials: { url, authToken },
      }
    : {
        schema: './src/db/schema.ts',
        out: './migrations',
        dialect: 'sqlite',
        dbCredentials: { url },
      }
);
