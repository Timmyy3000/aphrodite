import { describe, expect, it } from 'vitest';
import { AssetV1, ErrorEnvelopeV1, FileRefV1, ScreenListV1 } from '../../src/contracts/v1.js';
describe('versioned contracts', () => {
  it('rejects unknown public fields', () => expect(() => FileRefV1.parse({ alias: 'x', extra: true })).toThrow());
  it('validates stable error envelopes', () => expect(ErrorEnvelopeV1.parse({ schemaVersion: 1, error: { code: 'NODE_NOT_FOUND', message: 'missing', retryable: false } }).error.code).toBe('NODE_NOT_FOUND'));
  it('requires tracked-project copy guidance on assets', () => expect(() => AssetV1.parse({ canonicalNodeId: '1:2', rawReference: 'abc', kind: 'raster', status: 'missing' })).toThrow());
  it('accepts only normalized document-relative asset paths', () => {
    const base = { canonicalNodeId: '1:2', rawReference: 'abc', kind: 'raster', status: 'resolved', mustCopyToTrackedProject: true } as const;
    expect(() => AssetV1.parse({ ...base, cacheSourcePath: '../outside.png' })).toThrow();
    expect(AssetV1.parse({ ...base, cacheSourcePath: 'assets/raster/raster-node-1-2-ref-abc.png' }).cacheSourcePath).toContain('assets/raster/');
  });
  it('keeps screen list versioned', () => expect(ScreenListV1.parse({ schemaVersion: 1, document: { importId: 'x', formatVersion: 106 }, pages: [], truncation: { returnedNodes: 0, omittedNodes: 0, omittedAssets: 0, omittedGuidance: 0, textTruncated: false, truncated: false }, warnings: [] }).schemaVersion).toBe(1));
});
