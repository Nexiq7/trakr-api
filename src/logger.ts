import { env } from './env';

type Level = 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

/**
 * Structured logging.
 *
 * Production prints one JSON object per line to stdout/stderr — the shape
 * Docker/Dokploy log drivers (and tools like Dozzle or Loki) expect. Local dev
 * prints a compact human-readable line instead, since nobody wants to read
 * JSON in a terminal.
 */
function write(level: Level, message: string, meta?: Meta) {
  const time = new Date().toISOString();
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (env.isProduction) {
    sink(JSON.stringify({ time, level, message, ...meta }));
    return;
  }

  const suffix = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
  sink(`${time} [${level.toUpperCase()}] ${message}${suffix}`);
}

export const logger = {
  info: (message: string, meta?: Meta) => write('info', message, meta),
  warn: (message: string, meta?: Meta) => write('warn', message, meta),
  error: (message: string, meta?: Meta) => write('error', message, meta),
};
