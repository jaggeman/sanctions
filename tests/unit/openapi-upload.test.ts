import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';

describe('OpenAPI specification for POST /api/upload (issue #162)', () => {
  const openApiPath = path.resolve(__dirname, '../../src/api/openapi.json');
  const spec = fs.readJsonSync(openApiPath);
  const uploadOp = spec.paths?.['/api/upload']?.post;

  it('spec contains /api/upload POST operation', () => {
    expect(uploadOp).toBeDefined();
  });

  it('does NOT document 202 response for /api/upload since handler runs synchronously', () => {
    expect(uploadOp.responses?.['202']).toBeUndefined();
  });

  it('documents 200, 400, 401, 403, 409, 413, 422, and 500 responses for /api/upload', () => {
    const statusCodes = Object.keys(uploadOp.responses || {});
    expect(statusCodes).toContain('200');
    expect(statusCodes).toContain('400');
    expect(statusCodes).toContain('401');
    expect(statusCodes).toContain('403');
    expect(statusCodes).toContain('409');
    expect(statusCodes).toContain('413');
    expect(statusCodes).toContain('422');
    expect(statusCodes).toContain('500');
  });

  it('documents 409 response with duplicateOfImportId schema', () => {
    const res409 = uploadOp.responses?.['409'];
    expect(res409).toBeDefined();
    const rawJson = JSON.stringify(res409);
    expect(rawJson).toContain('duplicateOfImportId');
  });

  it('documents requestBody fields mode, dryRun, force, and importId', () => {
    const schema =
      uploadOp.requestBody?.content?.['multipart/form-data']?.schema;
    expect(schema).toBeDefined();
    expect(schema.properties).toBeDefined();
    expect(schema.properties.file).toBeDefined();
    expect(schema.properties.source).toBeDefined();
    expect(schema.properties.mode).toBeDefined();
    expect(schema.properties.dryRun).toBeDefined();
    expect(schema.properties.force).toBeDefined();
    expect(schema.properties.importId).toBeDefined();
  });
});
