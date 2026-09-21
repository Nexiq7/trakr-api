import { env } from './env';
import { currentRequest } from './request-context';

type Level = 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

/**
 * Structured logging.
 *
 * Production prints one JSON object per line to stdout/stderr — the shape
 * Docker/Dokploy log drivers (and Loki, via Grafana Alloy) expect. Local dev
 * prints a compact human-readable line instead, since nobody wants to read
 * JSON in a terminal.
 *
 * Every line carries:
 * - `service` and `version`, so lines can be told apart across apps and
 *   deploys (`version` is the git commit the image was built from);
 * - the current request's `requestId`, `userId` and `username` when written
 *   while handling a request, so any line can be traced back to who caused it;
 * - an `event` for anything worth searching for by name (`auth.signup`,
 *   `watchlist.add`…). `message` stays human-readable; `event` is the stable
 *   key to filter and alert on.
 */
const base = { service: 'trakr-api', version: env.version };

function write(level: Level, message: string, meta?: Meta) {
  const time = new Date().toISOString();
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const request = currentRequest();

  if (env.isProduction) {
    sink(JSON.stringify({ time, level, message, ...base, ...request, ...meta }));
    return;
  }

  const fields = { ...request, ...meta };
  const suffix = Object.keys(fields).length > 0 ? ' ' + JSON.stringify(fields) : '';
  sink(`${time} [${level.toUpperCase()}] ${message}${suffix}`);
}

export const logger = {
  info: (message: string, meta?: Meta) => write('info', message, meta),
  warn: (message: string, meta?: Meta) => write('warn', message, meta),
  error: (message: string, meta?: Meta) => write('error', message, meta),
};

/** An error as log fields: its message, plus the stack when there is one. */
export function errorFields(error: unknown) {
  return error instanceof Error
    ? { error: error.message, errorName: error.name, stack: error.stack }
    : { error: String(error) };
}
