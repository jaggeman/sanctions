type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Field names redacted verbatim, regardless of nesting depth. Email gets
// special handling below (domain kept, local part masked) rather than a
// blanket drop, per CLAUDE.md's "log a domain, not a full email" guidance.
const REDACTED_KEYS = new Set([
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'sessionid',
  'session_id',
]);

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '[REDACTED]';
  return `${email[0]}***${email.slice(at)}`;
}

function serializeError(err: Error): Record<string, unknown> {
  return { name: err.name, message: err.message, stack: err.stack };
}

function redactValue(key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  const lowerKey = key.toLowerCase();
  if (lowerKey === 'email' && typeof value === 'string') return maskEmail(value);
  if (REDACTED_KEYS.has(lowerKey)) return '[REDACTED]';
  return serializeContext(value);
}

function serializeContext(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map((item) => serializeContext(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactValue(key, nested);
    }
    return out;
  }
  return value;
}

function write(level: LogLevel, message: string, context: Record<string, unknown> | undefined, base: Record<string, unknown>) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel()]) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(serializeContext(base) as Record<string, unknown>),
    ...(context ? (serializeContext(context) as Record<string, unknown>) : {}),
  };

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (message, context) => write('debug', message, context, base),
    info: (message, context) => write('info', message, context, base),
    warn: (message, context) => write('warn', message, context, base),
    error: (message, context) => write('error', message, context, base),
    child: (context) => createLogger({ ...base, ...context }),
  };
}

export const logger = createLogger();
