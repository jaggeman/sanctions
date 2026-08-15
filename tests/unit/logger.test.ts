import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/shared/logger';

function readJsonLines(spy: ReturnType<typeof vi.spyOn>): any[] {
  return spy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

describe('logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('LOG_LEVEL', 'debug');
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('writes info/debug/warn to their own streams as parseable JSON', () => {
    const logger = createLogger();
    logger.info('hello');
    logger.debug('details');
    logger.warn('careful');

    const infoEntries = readJsonLines(logSpy);
    expect(infoEntries.some((e) => e.level === 'info' && e.message === 'hello')).toBe(true);
    expect(infoEntries.some((e) => e.level === 'debug' && e.message === 'details')).toBe(true);

    const warnEntries = readJsonLines(warnSpy);
    expect(warnEntries.some((e) => e.level === 'warn' && e.message === 'careful')).toBe(true);
  });

  it('writes error level to console.error', () => {
    const logger = createLogger();
    logger.error('boom');
    const entries = readJsonLines(errorSpy);
    expect(entries[0]).toMatchObject({ level: 'error', message: 'boom' });
  });

  it('every entry has an ISO timestamp', () => {
    const logger = createLogger();
    logger.info('hello');
    const [entry] = readJsonLines(logSpy);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('filters out levels below LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'warn');
    const logger = createLogger();
    logger.debug('nope');
    logger.info('also nope');
    logger.warn('yes');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('redacts known-sensitive keys regardless of nesting', () => {
    const logger = createLogger();
    logger.info('login attempt', {
      password: 'hunter2',
      token: 'abc123',
      nested: { apiKey: 'super-secret', authorization: 'Bearer xyz' },
    });
    const [entry] = readJsonLines(logSpy);
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.token).toBe('[REDACTED]');
    expect(entry.nested.apiKey).toBe('[REDACTED]');
    expect(entry.nested.authorization).toBe('[REDACTED]');
  });

  it('masks emails instead of dropping them entirely', () => {
    const logger = createLogger();
    logger.info('otp requested', { email: 'jagannath.tammeleht@novro.se' });
    const [entry] = readJsonLines(logSpy);
    expect(entry.email).toBe('j***@novro.se');
    expect(entry.email).not.toContain('tammeleht');
  });

  it('serializes Error objects with name/message/stack instead of {}', () => {
    const logger = createLogger();
    logger.error('search failed', { error: new Error('boom') });
    const [entry] = readJsonLines(errorSpy);
    expect(entry.error.name).toBe('Error');
    expect(entry.error.message).toBe('boom');
    expect(typeof entry.error.stack).toBe('string');
  });

  it('child() binds context onto every subsequent log line', () => {
    const logger = createLogger().child({ requestId: 'req-1' });
    logger.info('handling request');
    const [entry] = readJsonLines(logSpy);
    expect(entry.requestId).toBe('req-1');
  });

  it('child-of-child merges context from both levels', () => {
    const logger = createLogger().child({ requestId: 'req-1' }).child({ userEmail: 'u***@example.com' });
    logger.info('nested child');
    const [entry] = readJsonLines(logSpy);
    expect(entry.requestId).toBe('req-1');
    expect(entry.userEmail).toBe('u***@example.com');
  });
});
