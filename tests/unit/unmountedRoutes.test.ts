import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Regression for issue #106: src/api/routes/{auth,search,imports}.ts existed
// on main, fully unauthenticated as written, and were never imported by
// src/api/index.ts — a silent landmine if a future refactor ever wired them
// in as-is (this repo already had one incident, issue #86, where a route
// silently lost its auth middleware and nobody noticed until a live pen
// test found it). This test makes "a router file exists under
// src/api/routes/ but nothing actually mounts it" a build-time failure
// instead of a thing a reviewer has to remember to check by hand.
describe('every file under src/api/routes/ is actually imported by src/api/index.ts', () => {
  const routesDir = path.join(__dirname, '../../src/api/routes');
  const indexSource = fs.readFileSync(path.join(__dirname, '../../src/api/index.ts'), 'utf-8');

  const routeFiles = fs
    .readdirSync(routesDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.replace(/\.ts$/, ''));

  // Sanity check on the test itself: if this list is ever empty, the glob
  // above is broken, not "there happen to be no route files."
  it('found at least one route file to check', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it.each(routeFiles)('%s.ts is imported somewhere in src/api/index.ts', (baseName) => {
    const importPattern = new RegExp(`from ['"]\\./routes/${baseName}['"]`);
    expect(indexSource).toMatch(importPattern);
  });
});
