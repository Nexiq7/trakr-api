import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { env } from "../env";

// A local `file:` database takes no auth token, and libsql rejects the option
// outright rather than ignoring it — so it's only passed for remote servers.
const client = createClient(
  env.isRemoteDatabase
    ? { url: env.databaseUrl, authToken: env.databaseAuthToken }
    : { url: env.databaseUrl }
);

export const db = drizzle(client);
