import { AphroditeError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';
export function normalizeBlob(value: unknown, index: number): Uint8Array {
  const candidate: any = value instanceof Uint8Array || Array.isArray(value) ? value : (value as any)?.bytes;
  if (!(candidate instanceof Uint8Array) && !Array.isArray(candidate)) throw new AphroditeError('BLOB_INVALID', `Blob ${index} does not contain bytes.`);
  if (candidate.length > LIMITS.maxBlobBytes) throw new AphroditeError('BLOB_INVALID', `Blob ${index} contains invalid bytes.`, { index, size: candidate.length });
  for (let offset = 0; offset < candidate.length; offset++) { const byte = candidate[offset]; if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) throw new AphroditeError('BLOB_INVALID', `Blob ${index} contains invalid bytes.`, { index, size: candidate.length }); }
  const bytes = candidate instanceof Uint8Array ? new Uint8Array(candidate) : Uint8Array.from(candidate);
  return bytes;
}
export function validateBlobs(blobs: unknown[]) {
  let total = 0;
  for (let index = 0; index < blobs.length; index++) {
    const value: any = blobs[index];
    const candidate = value instanceof Uint8Array || Array.isArray(value) ? value : value?.bytes;
    if (!(candidate instanceof Uint8Array) && !Array.isArray(candidate)) throw new AphroditeError('BLOB_INVALID', `Blob ${index} does not contain bytes.`);
    total += candidate.length;
    if (candidate.length > LIMITS.maxBlobBytes || total > LIMITS.maxAllBlobBytes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Blob storage exceeded its configured limit.', { resource: 'all blobs', observed: total, limit: LIMITS.maxAllBlobBytes });
    for (let offset = 0; offset < candidate.length; offset++) { const byte = candidate[offset]; if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) throw new AphroditeError('BLOB_INVALID', `Blob ${index} contains invalid bytes.`, { index, size: candidate.length }); }
  }
}
export function referencedBlob(blobs: unknown[], index: unknown) { const numeric = Number(index); if (!Number.isInteger(numeric) || numeric < 0 || numeric >= blobs.length) throw new AphroditeError('BLOB_INVALID', `Blob reference ${String(index)} is out of range.`); return normalizeBlob(blobs[numeric], numeric); }
export type CommandPath = Array<string | number>;
export function decodeCommands(bytes: Uint8Array): CommandPath {
  // Empty fill geometry is a valid no-op in real .fig files; callers expose it
  // as unsupported rather than manufacturing an empty resolved asset.
  if (bytes.length === 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0; const path: CommandPath = []; let moves = 0;
  const readFloat = () => { if (offset + 4 > bytes.length) throw new AphroditeError('BLOB_INVALID', 'Command blob ended in an incomplete operand.'); const value = view.getFloat32(offset, true); offset += 4; if (!Number.isFinite(value)) throw new AphroditeError('BLOB_INVALID', 'Command blob contains a non-finite coordinate.'); return value; };
  while (offset < bytes.length) { const op = bytes[offset++]; if (op === 0) path.push('Z'); else if (op === 1) { path.push('M', readFloat(), readFloat()); moves++; } else if (op === 2) path.push('L', readFloat(), readFloat()); else if (op === 3) path.push('Q', readFloat(), readFloat(), readFloat(), readFloat()); else if (op === 4) path.push('C', readFloat(), readFloat(), readFloat(), readFloat(), readFloat(), readFloat()); else throw new AphroditeError('BLOB_INVALID', `Unknown command opcode ${op}.`); }
  if (!moves) throw new AphroditeError('BLOB_INVALID', 'Command blob must contain a move command.'); return path;
}
export interface VectorNetwork { vertices: Array<{ styleID: number; x: number; y: number }>; segments: Array<{ styleID: number; start: { vertex: number; dx: number; dy: number }; end: { vertex: number; dx: number; dy: number } }>; regions: Array<{ styleID: number; windingRule: 'ODD' | 'NONZERO'; loops: Array<{ segments: number[] }> }>; }
export function decodeVectorNetwork(bytes: Uint8Array): VectorNetwork {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0; const need = (n: number) => { if (n < 0 || offset > bytes.length - n) throw new AphroditeError('BLOB_INVALID', 'Vector network blob is truncated.'); }; const u32 = () => { need(4); const n = view.getUint32(offset, true); offset += 4; return n; }; const f32 = () => { need(4); const n = view.getFloat32(offset, true); offset += 4; if (!Number.isFinite(n)) throw new AphroditeError('BLOB_INVALID', 'Vector network contains a non-finite coordinate.'); return n; }; const boundedCount = (count: number, limit: number, minimumBytes: number, label: string) => { if (count > limit || count > Math.floor((bytes.length - offset) / minimumBytes)) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', `Vector ${label} count exceeded its limit.`, { count, limit }); return count; };
  need(12); const vertexCount = boundedCount(u32(), LIMITS.maxVectorVertices, 12, 'vertex'); const segmentCount = boundedCount(u32(), LIMITS.maxVectorSegments, 28, 'segment'); const regionCount = boundedCount(u32(), LIMITS.maxVectorRegions, 8, 'region');
  if (vertexCount + segmentCount + regionCount > LIMITS.maxVectorAllocations) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Vector network allocation count exceeded its limit.', { limit: LIMITS.maxVectorAllocations });
  const vertices: VectorNetwork['vertices'] = []; for (let index = 0; index < vertexCount; index++) vertices.push({ styleID: u32(), x: f32(), y: f32() });
  const segments: VectorNetwork['segments'] = []; for (let index = 0; index < segmentCount; index++) { const styleID = u32(); const startVertex = u32(); const dx = f32(); const dy = f32(); const endVertex = u32(); const endDx = f32(); const endDy = f32(); if (startVertex >= vertexCount || endVertex >= vertexCount) throw new AphroditeError('BLOB_INVALID', 'Vector network segment references an invalid vertex.'); segments.push({ styleID, start: { vertex: startVertex, dx, dy }, end: { vertex: endVertex, dx: endDx, dy: endDy } }); }
  const regions: VectorNetwork['regions'] = []; let totalLoops = 0; let totalIndices = 0;
  for (let index = 0; index < regionCount; index++) {
    let styleID = u32(); const windingRule = (styleID & 1) ? 'NONZERO' as const : 'ODD' as const; styleID >>>= 1; const loopCount = boundedCount(u32(), LIMITS.maxVectorLoops, 4, 'loop'); totalLoops += loopCount;
    if (totalLoops > LIMITS.maxVectorLoops || vertexCount + segmentCount + regionCount + totalLoops > LIMITS.maxVectorAllocations) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Vector network loop allocation count exceeded its limit.', { limit: LIMITS.maxVectorAllocations });
    const loops: Array<{ segments: number[] }> = [];
    for (let loopIndex = 0; loopIndex < loopCount; loopIndex++) {
      const indexCount = boundedCount(u32(), LIMITS.maxVectorIndices, 4, 'index'); totalIndices += indexCount;
      if (totalIndices > LIMITS.maxVectorIndices || vertexCount + segmentCount + regionCount + totalLoops + totalIndices > LIMITS.maxVectorAllocations) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Vector network index allocation count exceeded its limit.', { limit: LIMITS.maxVectorAllocations });
      const indices: number[] = [];
      for (let indexIndex = 0; indexIndex < indexCount; indexIndex++) { const segmentIndex = u32(); if (segmentIndex >= segmentCount) throw new AphroditeError('BLOB_INVALID', 'Vector region references an invalid segment.'); indices.push(segmentIndex); }
      loops.push({ segments: indices });
    }
    regions.push({ styleID, windingRule, loops });
  }
  if (offset !== bytes.length) throw new AphroditeError('BLOB_INVALID', 'Vector network blob has trailing bytes.'); return { vertices, segments, regions };
}
export interface SvgPaint { fill: string; opacity?: number; }

/**
 * Resolve the one paint shape we can reproduce without guessing: a single
 * visible solid fill. Gradients, images, multiple paints, and effects remain
 * unsupported so an asset is never reported as resolved with the wrong color.
 */
export function nodeSvgPaint(raw: any): SvgPaint | undefined {
  const paints: any[] = [];
  for (const value of [raw?.fillPaints, raw?.fills]) {
    for (const paint of Array.isArray(value) ? value : value ? [value] : []) paints.push(paint);
  }
  const visible = paints.filter(paint => paint && paint.visible !== false && Number(paint.opacity ?? 1) > 0);
  if (visible.length !== 1 || visible[0]?.type !== 'SOLID') return undefined;
  const color = visible[0]?.color;
  const channels = ['r', 'g', 'b'].map(channel => Number(color?.[channel]));
  const opacity = Number(visible[0]?.opacity ?? 1) * Number(color?.a ?? 1);
  if (!color || channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) return undefined;
  const rgb = channels.map(channel => Math.round(channel * 255));
  return { fill: `rgb(${rgb.join(', ')})`, ...(opacity < 1 ? { opacity } : {}) };
}

function paintAttributes(paint: SvgPaint | undefined) {
  if (!paint) return undefined;
  return `fill="${paint.fill}"${paint.opacity === undefined ? '' : ` fill-opacity="${paint.opacity}"`}`;
}

export function commandsToSvg(path: CommandPath, viewBox = '0 0 100 100', paint?: SvgPaint) {
  const attributes = paintAttributes(paint);
  if (!attributes) return undefined;
  let d = '';
  for (let i = 0; i < path.length;) {
    const token = path[i++];
    if (typeof token !== 'string') continue;
    d += token === 'Z' ? 'Z ' : `${token} ${path.slice(i, i + (token === 'C' ? 6 : token === 'Q' ? 4 : 2)).join(' ')} `;
    i += token === 'C' ? 6 : token === 'Q' ? 4 : 2;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><path d="${d.trim()}" ${attributes}/></svg>\n`;
}
export function vectorToSvg(network: VectorNetwork, viewBox = '0 0 100 100', paint?: SvgPaint) {
  // Without Figma's paint/style table, even a geometrically valid network is
  // not safe to claim as resolved. Callers must provide a verified solid fill.
  const attributes = paintAttributes(paint);
  if (!attributes) return undefined;
  if (network.vertices.some(vertex => vertex.styleID !== 0) || network.segments.some(segment => segment.styleID !== 0) || network.regions.some(region => region.styleID !== 0)) return undefined;
  const paths: string[] = [];
  for (const region of network.regions) for (const loop of region.loops) { if (!loop.segments.length) return undefined; let d = ''; let first: number | undefined; let previous: number | undefined; for (const segmentIndex of loop.segments) { const segment = network.segments[segmentIndex]; if (segment.start.dx !== 0 || segment.start.dy !== 0 || segment.end.dx !== 0 || segment.end.dy !== 0) return undefined; if (previous !== undefined && segment.start.vertex !== previous) return undefined; const start = network.vertices[segment.start.vertex]; const end = network.vertices[segment.end.vertex]; if (first === undefined) { first = segment.start.vertex; d += `M ${start.x} ${start.y} `; } d += `L ${end.x} ${end.y} `; previous = segment.end.vertex; } if (previous !== first) return undefined; paths.push(`<path d="${d}Z" ${attributes} fill-rule="${region.windingRule === 'NONZERO' ? 'nonzero' : 'evenodd'}"/>`); }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${paths.join('')}</svg>\n`;
}
