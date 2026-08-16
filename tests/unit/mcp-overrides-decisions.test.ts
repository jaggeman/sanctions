import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getOverride = vi.fn();
const listDecisionsForEntity = vi.fn();

vi.mock('../../src/overrides', () => ({ getOverride }));
vi.mock('../../src/decisions', () => ({ listDecisionsForEntity }));
vi.mock('../../src/search', () => ({ runSearch: vi.fn(), invalidateSearchIndex: vi.fn() }));
vi.mock('../../src/shared/firebase', () => ({ db: { collection: vi.fn() } }));
vi.mock('../../src/importer', () => ({ runImport: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler() {}
    connect() { return Promise.resolve(); }
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

const {
  callSanctionsApi,
  handleGetOverride,
  handleCreateOverride,
  handleRecordDecision,
  handleListDecisionsForEntity,
} = await import('../../src/mcp/index');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MCP_API_BASE_URL;
  delete process.env.MCP_API_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe('handleGetOverride — MCP get_override tool', () => {
  it('returns the override fields when one exists', async () => {
    getOverride.mockResolvedValue({
      entityId: 'EU-1',
      fields: { sanctionReason: 'Corrected' },
      overriddenBy: 'analyst@corp.test',
      overriddenAt: '2026-01-01T00:00:00.000Z',
      reason: 'Fix',
    });

    const result = await handleGetOverride({ entityId: 'EU-1' });

    expect(getOverride).toHaveBeenCalledWith('EU-1');
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Corrected');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a friendly message when no override exists for the id', async () => {
    getOverride.mockResolvedValue(null);

    const result = await handleGetOverride({ entityId: 'EU-404' });

    expect(result.content[0].text).toMatch(/ingen|no override|EU-404/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('handleListDecisionsForEntity — MCP list_decisions_for_entity tool', () => {
  it('lists all decisions for the entity', async () => {
    listDecisionsForEntity.mockResolvedValue([
      { entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive', decidedBy: 'analyst@corp.test', decidedAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const result = await handleListDecisionsForEntity({ entityId: 'EU-1' });

    expect(listDecisionsForEntity).toHaveBeenCalledWith('EU-1');
    expect(result.content[0].text).toContain('cust-a');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports no decisions found when the list is empty', async () => {
    listDecisionsForEntity.mockResolvedValue([]);

    const result = await handleListDecisionsForEntity({ entityId: 'EU-1' });

    expect(result.content[0].text).toMatch(/inga|no decisions/i);
  });
});

describe('callSanctionsApi', () => {
  it('returns an error result when MCP_API_BASE_URL is unset', async () => {
    process.env.MCP_API_TOKEN = 'sanc_sometoken';

    const result = await callSanctionsApi('PUT', '/api/overrides/EU-1', { fields: {}, reason: 'x' });

    expect(result.ok).toBe(false);
    expect(result.body.error).toMatch(/MCP_API_BASE_URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns an error result when MCP_API_TOKEN is unset', async () => {
    process.env.MCP_API_BASE_URL = 'http://localhost:3000';

    const result = await callSanctionsApi('PUT', '/api/overrides/EU-1', { fields: {}, reason: 'x' });

    expect(result.ok).toBe(false);
    expect(result.body.error).toMatch(/MCP_API_TOKEN/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the Authorization: Bearer header and the configured base URL', async () => {
    process.env.MCP_API_BASE_URL = 'http://localhost:3000';
    process.env.MCP_API_TOKEN = 'sanc_sometoken';
    (fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await callSanctionsApi('PUT', '/api/overrides/EU-1', { fields: { x: 1 }, reason: 'r' });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/overrides/EU-1',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer sanc_sometoken',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ fields: { x: 1 }, reason: 'r' }),
      }),
    );
  });

  it('surfaces the real network error message when fetch rejects', async () => {
    process.env.MCP_API_BASE_URL = 'http://localhost:3000';
    process.env.MCP_API_TOKEN = 'sanc_sometoken';
    (fetch as any).mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await callSanctionsApi('PUT', '/api/overrides/EU-1', { fields: {}, reason: 'x' });

    expect(result.ok).toBe(false);
    expect(result.body.error).toMatch(/ECONNREFUSED/);
  });

  it("surfaces the server's own error body on a non-2xx response instead of a generic message", async () => {
    process.env.MCP_API_BASE_URL = 'http://localhost:3000';
    process.env.MCP_API_TOKEN = 'sanc_sometoken';
    (fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'These fields cannot be overridden: status.' }),
    });

    const result = await callSanctionsApi('PUT', '/api/overrides/EU-1', { fields: { status: 'active' }, reason: 'x' });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('These fields cannot be overridden: status.');
  });

  it('returns the parsed body on success', async () => {
    process.env.MCP_API_BASE_URL = 'http://localhost:3000';
    process.env.MCP_API_TOKEN = 'sanc_sometoken';
    (fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ entityId: 'EU-1', overriddenBy: 'svc@corp.test' }),
    });

    const result = await callSanctionsApi('PUT', '/api/overrides/EU-1', { fields: {}, reason: 'x' });

    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ entityId: 'EU-1', overriddenBy: 'svc@corp.test' });
  });
});

describe('handleCreateOverride — MCP create_override tool', () => {
  beforeEach(() => {
    process.env.MCP_API_BASE_URL = 'http://localhost:3000';
    process.env.MCP_API_TOKEN = 'sanc_sometoken';
  });

  it('PUTs to /api/overrides/:id with fields and reason', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ entityId: 'EU-1', overriddenBy: 'svc@corp.test' }),
    });

    const result = await handleCreateOverride({ entityId: 'EU-1', fields: { sanctionReason: 'Corrected' }, reason: 'Fix' });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/overrides/EU-1',
      expect.objectContaining({ method: 'PUT' }),
    );
    const call = (fetch as any).mock.calls[0][1];
    expect(JSON.parse(call.body)).toEqual({ fields: { sanctionReason: 'Corrected' }, reason: 'Fix' });
    expect(result.isError).toBeFalsy();
  });

  it('surfaces the 400 error body when the API rejects an immutable-key write', async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'These fields cannot be overridden: status.' }),
    });

    const result = await handleCreateOverride({ entityId: 'EU-1', fields: { status: 'active' }, reason: 'Fix' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('These fields cannot be overridden: status.');
  });

  it('surfaces the 404 when the target entity does not exist', async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'No sanctions record with id "DOES-NOT-EXIST" — cannot override a record that doesn\'t exist.' }),
    });

    const result = await handleCreateOverride({ entityId: 'DOES-NOT-EXIST', fields: { sanctionReason: 'x' }, reason: 'Fix' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DOES-NOT-EXIST');
  });
});

describe('handleRecordDecision — MCP record_decision tool', () => {
  beforeEach(() => {
    process.env.MCP_API_BASE_URL = 'http://localhost:3000';
    process.env.MCP_API_TOKEN = 'sanc_sometoken';
  });

  it('POSTs to /api/decisions with entityId/subjectId/verdict/notes', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive', decidedBy: 'svc@corp.test' }),
    });

    const result = await handleRecordDecision({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive', notes: 'Confirmed clean' });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/decisions',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = (fetch as any).mock.calls[0][1];
    expect(JSON.parse(call.body)).toEqual({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive', notes: 'Confirmed clean' });
    expect(result.isError).toBeFalsy();
  });

  it('omits notes from the request body when not provided', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive', decidedBy: 'svc@corp.test' }),
    });

    await handleRecordDecision({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive' });

    const call = (fetch as any).mock.calls[0][1];
    expect(JSON.parse(call.body)).toEqual({ entityId: 'EU-1', subjectId: 'cust-a', verdict: 'false_positive' });
  });

  it('surfaces the 400 validation error body from saveDecision verbatim', async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: '"entityId" must be a non-empty string of letters, numbers, "-", or "_".' }),
    });

    const result = await handleRecordDecision({ entityId: 'bad/id', subjectId: 'cust-a', verdict: 'false_positive' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"entityId" must be a non-empty string');
  });
});
