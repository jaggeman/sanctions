import { describe, it, expect, vi } from 'vitest';
import { validateEntityIdParam } from '../../src/api/middleware/validateEntityIdParam';

function fakeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe('validateEntityIdParam (Express param callback)', () => {
  it('calls next() with no error for a valid id', () => {
    const next = vi.fn();
    const res = fakeRes();
    validateEntityIdParam({} as any, res, next, 'EU-1234');
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 400 and does not call next() for a slash-containing id', () => {
    const next = vi.fn();
    const res = fakeRes();
    validateEntityIdParam({} as any, res, next, 'a/b');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/invalid/i) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 400 for an empty id', () => {
    const next = vi.fn();
    const res = fakeRes();
    validateEntityIdParam({} as any, res, next, '');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
