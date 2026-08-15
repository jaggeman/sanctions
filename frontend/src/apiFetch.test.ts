import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiFetch, setOnSessionExpired } from './apiFetch';

afterEach(() => {
  vi.unstubAllGlobals();
  setOnSessionExpired(null);
});

describe('apiFetch (issue #38)', () => {
  it('passes through a successful response unchanged, without firing the callback', async () => {
    const onExpired = vi.fn();
    setOnSessionExpired(onExpired);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) } as Response)));

    const res = await apiFetch('/api/search?q=test');

    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ hello: 'world' });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('fires the registered onSessionExpired callback for a 401 response', async () => {
    const onExpired = vi.fn();
    setOnSessionExpired(onExpired);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response)));

    await apiFetch('/api/search?q=test');

    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('still returns the 401 response to the caller — callers can inspect it themselves too', async () => {
    setOnSessionExpired(vi.fn());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response)));

    const res = await apiFetch('/api/search?q=test');

    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
  });

  it('does not throw and does not fire the callback when no listener is registered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) } as Response)));

    await expect(apiFetch('/api/search?q=test')).resolves.toBeDefined();
  });

  it('does not fire the callback for other error statuses (403, 404, 500)', async () => {
    const onExpired = vi.fn();
    setOnSessionExpired(onExpired);

    for (const status of [403, 404, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => ({}) } as Response)));
      await apiFetch('/api/search?q=test');
    }

    expect(onExpired).not.toHaveBeenCalled();
  });

  it('passes through the input/init arguments to the underlying fetch unchanged', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) } as Response));
    vi.stubGlobal('fetch', fetchSpy);

    await apiFetch('/api/admin/tokens', { method: 'POST', body: 'x' });

    expect(fetchSpy).toHaveBeenCalledWith('/api/admin/tokens', { method: 'POST', body: 'x' });
  });

  it('replacing the registered callback only invokes the latest one', async () => {
    const first = vi.fn();
    const second = vi.fn();
    setOnSessionExpired(first);
    setOnSessionExpired(second);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) } as Response)));

    await apiFetch('/api/search?q=test');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
