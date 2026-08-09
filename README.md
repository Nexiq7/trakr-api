<h1 align="center">trakr-api</h1>
<p align="center">
  The backend for trakr — a Hono API on Bun, backed by Turso (libsql) through Drizzle.
</p>

---

Serves the trakr frontend: authentication, the user's collection, and a proxy
layer over [TheTVDB v4 API](https://thetvdb.com/api-static/v4/index.html) that
prefers English titles and overviews when a title's primary language isn't English.

## 🚀 Run it

**You'll need:**
- [Bun](https://bun.sh)
- A free [TVDB API key](https://thetvdb.com/api-information)
- A free [Turso](https://turso.tech) database (or any libsql-compatible SQLite database)

```bash
cp .env.example .env    # fill in your TVDB key + Turso credentials

bun install
bun run db:push         # applies the database schema
bun run dev             # http://localhost:3007
```

For `JWT_SECRET`, paste in any random string — a generated password works fine.
Wrap it in quotes if it contains a `#`, which `.env` files treat as a comment.

Set `ORIGIN` to the frontend's public URL (comma-separate to allow more than one)
or CORS will reject the browser's requests.

The server validates its configuration on boot and refuses to start if anything
is missing or still set to a placeholder — so a misconfigured deploy fails loudly
instead of silently running with an insecure default.

### Docker

```bash
docker build -t trakr-api .
docker run -p 3007:3007 --env-file .env trakr-api
```

### Other scripts

```bash
bun run start       # production entrypoint
bun run typecheck
bun run db:studio   # Drizzle Studio
```

Health check → `GET /health`.

## 🛠️ Tech stack

Hono on Bun, Drizzle ORM, Turso (libsql), bcryptjs + hono-sessions for auth.

## 📄 License

[MIT](LICENSE) © Nexiq7. Series and episode data comes from TheTVDB and remains
subject to [their API terms](https://thetvdb.com/api-information) — this license
covers the code only.
