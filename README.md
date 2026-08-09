<h1 align="center">trakr-api</h1>
<p align="center">
  The backend for trakr — a Hono API on Bun, backed by SQLite (or Turso) through Drizzle.
</p>

---

Serves the trakr frontend: authentication, the user's collection, and a proxy
layer over [TheTVDB v4 API](https://thetvdb.com/api-static/v4/index.html) that
prefers English titles and overviews when a title's primary language isn't English.

This repo and [trakr-web](https://github.com/Nexiq7/trakr-web) together are the
whole product — nothing else runs behind [trakr.lol](https://trakr.lol).

## 🚀 Run the whole thing with Docker

The fastest path to a working trakr — API, web client, and a local SQLite
database, no cloud account needed:

```bash
git clone https://github.com/Nexiq7/trakr-api.git
cd trakr-api
cp .env.example .env    # add your TVDB key, set a JWT secret

docker compose up
```

Open [http://localhost:8080](http://localhost:8080). The API listens on
`:3007`; the database lives on a named Docker volume, so it survives restarts.

A free TVDB API key is the only external dependency — grab one at
[thetvdb.com/api-information](https://thetvdb.com/api-information).

## 🚀 Run it from source

**You'll need:**

- [Bun](https://bun.sh)
- A free [TVDB API key](https://thetvdb.com/api-information)

```bash
cp .env.example .env    # fill in your TVDB key, set a JWT secret

bun install
bun run db:push         # creates ./data/trakr.db and applies the schema
bun run dev             # http://localhost:3007
```

That's it — `DATABASE_URL` defaults to a local SQLite file, so there's nothing
else to provision. Pair it with [trakr-web](https://github.com/Nexiq7/trakr-web)
running against `VITE_API_URL=http://localhost:3007` for the full app.

For `JWT_SECRET`, generate a real random value — `openssl rand -base64 32` — not
a short password. It signs every auth token; anyone who can guess it can mint a
token for any account. The server warns on boot if it looks too short.

Set `ORIGIN` to the frontend's origin (comma-separate to allow more than one) or
CORS will reject the browser's requests.

The server validates its configuration on boot and refuses to start if anything
required is missing or still set to a placeholder — so a misconfigured deploy
fails loudly instead of silently running with an insecure default.

### Using Turso instead of local SQLite

For a managed, multi-region, or shared database, point `DATABASE_URL` at a
[Turso](https://turso.tech) (or any libsql-compatible) database instead:

```bash
DATABASE_URL=libsql://your-database.turso.io
DATABASE_AUTH_TOKEN=your-turso-auth-token
```

This is what trakr.lol itself runs on. (`TURSO_DATABASE_URL` /
`TURSO_AUTH_TOKEN` are still read as fallbacks, for deploys from before this
option existed.)

### Docker, API only

```bash
docker build -t trakr-api .
docker run -p 3007:3007 -v trakr-data:/data --env-file .env trakr-api
```

### Other scripts

```bash
bun run start       # production entrypoint
bun run typecheck
bun run db:studio   # Drizzle Studio
```

Health check → `GET /health`.

## 🛠️ Tech stack

Hono on Bun, Drizzle ORM, SQLite/Turso (libsql), bcryptjs for auth.

## 📄 License

[MIT](LICENSE) © Nexiq7. Series and episode data comes from TheTVDB and remains
subject to [their API terms](https://thetvdb.com/api-information) — this license
covers the code only.
