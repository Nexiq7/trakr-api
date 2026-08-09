FROM oven/bun:1-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so code changes don't invalidate the install layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Drop root — the app only ever reads its own files.
USER bun

EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3007/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
