import { describe, it, expect } from 'vitest';
import { scheduledSourceFetch } from '../../src/scheduled';

describe('scheduledSourceFetch resource sizing (issue #293)', () => {
  it('configures explicit memory and timeout adequate for all 5 sources', () => {
    const endpoint = (scheduledSourceFetch as any).__endpoint;
    expect(endpoint).toBeDefined();
    
    // In firebase-functions v2, memory is exposed as availableMemoryMb (1024) or memory
    const memory = endpoint.availableMemoryMb ?? endpoint.memory;
    expect(['1GiB', 1024, '512MiB', 512]).toContain(memory);
    expect(endpoint.timeoutSeconds).toBeGreaterThanOrEqual(300);
  });
});
