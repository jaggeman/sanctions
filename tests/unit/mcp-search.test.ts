import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSearch = vi.fn();
vi.mock('../../src/search', () => ({ runSearch, invalidateSearchIndex: vi.fn() }));
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

const { handleSearchSanctions } = await import('../../src/mcp/index');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleSearchSanctions — MCP search_sanctions tool', () => {
  it('calls the shared runSearch with the query and options', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    await handleSearchSanctions({ query: 'Vladimir Putin', source: 'PEP', type: 'individual', limit: 5 });

    expect(runSearch).toHaveBeenCalledWith(
      'Vladimir Putin',
      expect.objectContaining({ source: 'PEP', type: 'individual', limit: 5 }),
    );
  });

  it('reports a friendly message when the query is empty', async () => {
    const result = await handleSearchSanctions({ query: '' });
    expect(runSearch).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/minst 2 tecken|query/i);
  });

  it('issue #37: rejects a 1-character query, matching the tool\'s own stated "minst 2 tecken" contract', async () => {
    const result = await handleSearchSanctions({ query: 'a' });
    expect(runSearch).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/minst 2 tecken/i);
  });

  it('issue #37: honors an explicit limit=0 instead of silently falling back to the default', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    await handleSearchSanctions({ query: 'Vladimir Putin', limit: 0 });

    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', expect.objectContaining({ limit: 0 }));
  });

  it('passes limit: undefined through to runSearch (its own default) when limit is omitted entirely', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    await handleSearchSanctions({ query: 'Vladimir Putin' });

    expect(runSearch).toHaveBeenCalledWith('Vladimir Putin', expect.objectContaining({ limit: undefined }));
  });

  it('formats each hit with its score and matched alias', async () => {
    runSearch.mockResolvedValue({
      results: [
        { id: 'PEP-1', primaryName: 'Vladimir Putin', source: 'PEP', type: 'individual', aliases: [], score: 92, matchedAlias: 'Vladimir Putin' },
      ],
      totalMatches: 1,
      truncated: false,
    });
    const result = await handleSearchSanctions({ query: 'Vladmir Putin' });
    expect(result.content[0].text).toContain('92');
    expect(result.content[0].text).toContain('PEP-1');
  });

  it('reports no-match text when nothing scores above threshold', async () => {
    runSearch.mockResolvedValue({ results: [], totalMatches: 0, truncated: false });
    const result = await handleSearchSanctions({ query: 'Nobody Findable' });
    expect(result.content[0].text).toMatch(/inga|hittade/i);
  });

  it('surfaces truncation instead of hiding it', async () => {
    runSearch.mockResolvedValue({
      results: [{ id: 'PEP-1', primaryName: 'XY', source: 'PEP', type: 'individual', aliases: [], score: 90, matchedAlias: 'XY' }],
      totalMatches: 50,
      truncated: true,
    });
    const result = await handleSearchSanctions({ query: 'XY' });
    expect(result.content[0].text).toMatch(/50/);
  });
});
