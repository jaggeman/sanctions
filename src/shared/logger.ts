/**
 * Retention decision (issue #114, confirmed 2026-08-16): this logger's
 * output is operational/ephemeral only, NOT a durable audit source.
 *
 * Under Cloud Functions, every line written here (via console.log/warn/error
 * below) is picked up automatically by GCP Cloud Logging, but this repo does
 * not configure a log sink/export or an extended-retention bucket anywhere
 * (see `firebase.json`) — so it sits in the project's default `_Default` log
 * bucket, subject to GCP's default retention (commonly ~30 days), and is
 * only queryable from the GCP Console/Cloud Logging Explorer by someone with
 * project access, not from within this app.
 *
 * That's a deliberate choice, not an accident of GCP defaults: this project
 * answers "can we look something up later" with Firestore audit
 * collections, not Cloud Logging —
 *   - `sanctions/{id}` + its `versions` subcollection (issue #9)
 *   - `imports/{sha256}` (issue #7)
 *   - `overrides/{entityId}` (issue #35)
 *   - `decisions/{entityId}_{subjectId}` (issue #22)
 * Anything that needs to be looked up later belongs in one of those
 * collections, not inferred from a log line. If a future need arises for
 * durable operational logs too (e.g. a warn/error sink to Cloud Storage or
 * BigQuery), that's a new, explicit decision — not a reason to assume this
 * logger's output already survives past the default retention window.
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Substrings matched anywhere in the lowercased key name, not an exact-match
// set (issue #67) — an exact set missed `apiToken`/`userSecret`, only ever
// catching a field named precisely `token`/`secret`.
const REDACTED_KEY_SUBSTRINGS = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'sessionid',
  'session_id',
];

function isRedactedKey(lowerKey: string): boolean {
  return REDACTED_KEY_SUBSTRINGS.some((substring) => lowerKey.includes(substring));
}

// Matches an email address anywhere inside a string, not only a string that
// is itself nothing but an email — issue #67: a field named anything other
// than `email` (`userEmail`), or free text with an address embedded inside a
// longer value (a decision's `notes`, an override's `reason`), was invisible
// to the old key-name-only check.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

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

/**
 * Masks every embedded email address in a string, wherever it appears —
 * whether the whole string is just an email (the old `email`-key special
 * case, now just one instance of this) or it's a free-text field with an
 * address embedded inside a longer value.
 */
function redactEmailsInText(value: string): string {
  return value.replace(EMAIL_PATTERN, (match) => maskEmail(match));
}

function redactValue(key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  const lowerKey = key.toLowerCase();
  if (isRedactedKey(lowerKey)) return '[REDACTED]';
  if (typeof value === 'string') return redactEmailsInText(value);
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
