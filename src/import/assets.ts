import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphResult, GraphNode } from './graph.js';
import { referencedBlob, decodeCommands, commandsToSvg, decodeVectorNetwork, vectorToSvg, nodeSvgPaint } from './blobs.js';
import type { CacheAssetRecordV1 } from '../contracts/cache-v1.js';
import { AphroditeError } from '../core/errors.js';

export interface AssetExtraction { records: CacheAssetRecordV1[]; warnings: string[]; }
function imageHash(value: unknown) {
  if (typeof value === 'string') { const normalized = value.toLowerCase().replaceAll('-', ''); return /^[0-9a-f]{40}$/.test(normalized) ? normalized : undefined; }
  if (value instanceof Uint8Array || Array.isArray(value)) {
    const bytes = value instanceof Uint8Array ? value : value as unknown[];
    if (bytes.length !== 20 || bytes.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined;
    return Array.from(bytes as ArrayLike<number>, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  if (value && typeof value === 'object' && 'hash' in value) return imageHash((value as { hash: unknown }).hash);
  return undefined;
}
function mime(bytes: Uint8Array) { if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ['image/png', 'png'] as const; if (bytes[0] === 0xff && bytes[1] === 0xd8) return ['image/jpeg', 'jpg'] as const; if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return ['image/gif', 'gif'] as const; if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return ['image/webp', 'webp'] as const; if (new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().startsWith('<svg')) return ['image/svg+xml', 'svg'] as const; return undefined; }
function dims(bytes: Uint8Array, type: string) { if (type === 'image/png' && bytes.length >= 24) return { width: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16), height: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20) }; if (type === 'image/gif' && bytes.length >= 10) { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return { width: view.getUint16(6, true), height: view.getUint16(8, true) }; } return undefined; }
function asset(canonicalNodeId: string, rawReference: string | number, kind: 'raster' | 'svg', status: CacheAssetRecordV1['status'], extra: Partial<CacheAssetRecordV1> = {}): CacheAssetRecordV1 { return { canonicalNodeId, rawReference, kind, status, mustCopyToTrackedProject: true, ...extra }; }
function assetFilename(kind: 'raster' | 'svg', nodeId: string, reference: string | number, extension: string) {
  // Keep the node, asset kind, and source reference in every filename. This is
  // deterministic, safe to copy into a tracked project, and collision-free
  // even when a node has both command and vector payloads.
  const safeNode = nodeId.replaceAll(':', '-');
  const safeReference = String(reference).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${kind}-node-${safeNode}-ref-${safeReference}.${extension}`;
}
function imageRefs(raw: any): { source?: string; thumbnail?: string } {
  const sourceCandidates = [raw.imageRef, raw.imageHash, raw.image?.hash, raw.image];
  const thumbnailCandidates = [raw.imageThumbnail?.hash, raw.imageThumbnail, raw.thumbnailHash];
  // v106 canvas exports store image paints under `fillPaints` (the parser-shaped
  // JSON shown by madebyevan.com uses this spelling), while older snapshots may
  // expose the Figma REST-style `fills` field. Keep both paths so raster paints
  // are not silently omitted from real .fig imports.
  for (const paints of [raw.fillPaints, raw.fills]) {
    for (const paint of Array.isArray(paints) ? paints : paints ? [paints] : []) {
      sourceCandidates.push(paint?.imageRef, paint?.imageHash, paint?.image?.hash, paint?.image);
      thumbnailCandidates.push(paint?.imageThumbnail?.hash, paint?.imageThumbnail, paint?.thumbnailHash);
    }
  }
  return { source: sourceCandidates.map(imageHash).find(Boolean), thumbnail: thumbnailCandidates.map(imageHash).find(Boolean) };
}
function blobRefs(raw: any, key: 'commandsBlob' | 'vectorNetworkBlob'): number[] {
  const refs: number[] = [];
  const add = (value: unknown) => { if (value === undefined || value === null) return; const numeric = Number(value); if (!Number.isInteger(numeric) || numeric < 0) throw new AphroditeError('BLOB_INVALID', `Blob reference ${String(value)} is invalid.`); if (!refs.includes(numeric)) refs.push(numeric); };
  add(raw[key]);
  if (key === 'commandsBlob' && Array.isArray(raw.fillGeometry)) for (const geometry of raw.fillGeometry) add(geometry?.commandsBlob);
  if (key === 'vectorNetworkBlob') add(raw.vectorData?.vectorNetworkBlob);
  if (key === 'commandsBlob' && Array.isArray(raw.derivedSymbolData)) {
    const walk = (value: unknown, depth: number) => { if (depth > 4 || !value || typeof value !== 'object') return; if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; } const object = value as Record<string, unknown>; add(object.commandsBlob); for (const child of Object.values(object)) walk(child, depth + 1); };
    walk(raw.derivedSymbolData, 0);
  }
  return refs;
}
export async function extractAssets(graph: GraphResult, blobs: unknown[], images: Map<string, Uint8Array>, assetsRoot: string, signal?: AbortSignal): Promise<AssetExtraction> {
  await mkdir(join(assetsRoot, 'raster'), { recursive: true });
  await mkdir(join(assetsRoot, 'vector'), { recursive: true });
  const records: CacheAssetRecordV1[] = [];
  const filenames = new Set<string>();
  const writeAsset = async (directory: 'raster' | 'vector', filename: string, bytes: Uint8Array | string) => {
    const key = `${directory}/${filename}`;
    if (filenames.has(key)) throw new AphroditeError('DOCUMENT_INVALID', `Asset filename collision for ${key}.`);
    filenames.add(key);
    await writeFile(join(assetsRoot, directory, filename), bytes);
  };
  const warnings = [...graph.warnings];
  for (const node of graph.nodes.values()) {
    if (signal?.aborted) throw new AphroditeError('IMPORT_CANCELLED', 'Import was cancelled.');
    const raw = node.raw;
    const refs = imageRefs(raw);
    const ref = refs.source && images.has(refs.source) ? refs.source : refs.thumbnail && images.has(refs.thumbnail) ? refs.thumbnail : refs.source ?? refs.thumbnail;
    const isThumbnail = Boolean(ref && refs.thumbnail === ref && refs.source !== ref);
    if (ref) {
      const bytes = images.get(ref);
      if (!bytes) records.push(asset(node.id, ref, 'raster', 'missing', { reasonCode: 'IMAGE_NOT_FOUND' }));
      else {
        const actual = createHash('sha1').update(bytes).digest('hex');
        if (actual !== ref) records.push(asset(node.id, ref, 'raster', 'invalid', { reasonCode: 'ASSET_HASH_MISMATCH' }));
        else {
          const type = mime(bytes);
          if (!type) records.push(asset(node.id, ref, 'raster', 'invalid', { reasonCode: 'MIME_UNKNOWN' }));
          else {
            const filename = assetFilename('raster', node.id, ref, type[1]);
            await writeAsset('raster', filename, bytes);
            records.push(asset(node.id, ref, 'raster', 'resolved', { cacheSourcePath: `assets/raster/${filename}`, mimeType: type[0], dimensions: dims(bytes, type[0]), ...(isThumbnail ? { reasonCode: 'IMAGE_THUMBNAIL_FALLBACK' } : {}) }));
          }
        }
      }
    }
    const commandRefs = blobRefs(raw, 'commandsBlob');
    for (const commandRef of commandRefs) {
      // Resolve the reference outside the geometry decoder: an absent/out-of-range
      // blob is an invalid import, while a known blob using an unsupported Figma
      // geometry encoding remains an explicit unsupported asset.
      const blob = referencedBlob(blobs, commandRef);
      const path = decodeCommands(blob);
      const filename = assetFilename('svg', node.id, `command-${commandRef}`, 'svg');
      const svg = path.length ? commandsToSvg(path, viewBox(raw), nodeSvgPaint(raw)) : undefined;
      if (!svg) records.push(asset(node.id, Number(commandRef), 'svg', 'unsupported', { reasonCode: 'VECTOR_COMMAND_UNSUPPORTED' }));
      else { await writeAsset('vector', filename, svg); records.push(asset(node.id, Number(commandRef), 'svg', 'resolved', { cacheSourcePath: `assets/vector/${filename}`, mimeType: 'image/svg+xml' })); }
    }
    const vectorRefs = blobRefs(raw, 'vectorNetworkBlob');
    for (const vectorRef of vectorRefs) {
      const blob = referencedBlob(blobs, vectorRef);
      const svg = vectorToSvg(decodeVectorNetwork(blob), viewBox(raw), nodeSvgPaint(raw));
      const filename = assetFilename('svg', node.id, `vector-${vectorRef}`, 'svg');
      if (!svg) records.push(asset(node.id, Number(vectorRef), 'svg', 'unsupported', { reasonCode: 'VECTOR_NETWORK_UNSUPPORTED' }));
      else { await writeAsset('vector', filename, svg); records.push(asset(node.id, Number(vectorRef), 'svg', 'resolved', { cacheSourcePath: `assets/vector/${filename}`, mimeType: 'image/svg+xml' })); }
    }
  }
  return { records, warnings };
}
function viewBox(raw: any) { const box = raw.absoluteBoundingBox; return box && Number.isFinite(Number(box.width)) && Number.isFinite(Number(box.height)) ? `0 0 ${Number(box.width)} ${Number(box.height)}` : '0 0 100 100'; }
