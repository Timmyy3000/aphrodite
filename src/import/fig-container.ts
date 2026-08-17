import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { fromBuffer, type ZipFile, type Entry } from 'yauzl';
import pako from 'pako';
import { Decompress as ZstdDecompress } from 'fzstd';
import * as kiwi from 'kiwi-schema';
import { AphroditeError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';

export interface DecodedCanvas { version: number; root: Record<string, unknown>; blobs: unknown[]; }
export interface ContainerInput { sourceBytes: Uint8Array; sourceName?: string; canvas: DecodedCanvas; images: Map<string, Uint8Array>; format: 'json' | 'raw' | 'zip'; }
export type ImportInput = string | Uint8Array | ArrayBuffer;

function bytesOf(input: Uint8Array | ArrayBuffer) { return input instanceof Uint8Array ? input : new Uint8Array(input); }
function u32(bytes: Uint8Array, offset: number) { if (offset < 0 || offset + 4 > bytes.byteLength) throw new AphroditeError('ARCHIVE_MALFORMED', 'Canvas chunk length is truncated.'); return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw new AphroditeError('IMPORT_CANCELLED', 'Import was cancelled.'); }
function validateDecodedStrings(value: unknown) {
  let total = 0;
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown) => {
    if (typeof candidate === 'string') {
      total += candidate.length;
      if (candidate.length > LIMITS.maxDecodedStringUnits || total > LIMITS.maxDecodedStringUnits) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Decoded canvas strings exceeded their configured limit.', { resource: 'decoded strings', observed: total, limit: LIMITS.maxDecodedStringUnits });
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (candidate instanceof Uint8Array) return;
    if (Array.isArray(candidate)) { for (const item of candidate) visit(item); return; }
    for (const item of Object.values(candidate as Record<string, unknown>)) visit(item);
  };
  visit(value);
}
function inflateRawBounded(encoded: Uint8Array, signal?: AbortSignal, maxOutput = LIMITS.maxInflatedChunkBytes) {
  const chunks: Uint8Array[] = []; let total = 0; const inflater = new pako.Inflate({ raw: true, chunkSize: 64 * 1024 });
  inflater.onData = (chunk: Uint8Array) => { checkAbort(signal); total += chunk.byteLength; if (total > maxOutput) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Inflated canvas chunk exceeded its limit.', { resource: 'inflated canvas chunk', observed: total, limit: maxOutput }); chunks.push(new Uint8Array(chunk)); };
  const ok = inflater.push(encoded, true); if (!ok || inflater.err) throw new AphroditeError('DECOMPRESSION_FAILED', inflater.msg || 'Raw deflate decompression failed.');
  const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; } return output;
}
export function zstdFrameBounds(encoded: Uint8Array, maxOutput: number) {
  // Preflight every frame, not just the first one. fzstd's streaming decoder
  // safely bounds emitted chunks, but it still allocates a per-frame window.
  // Parsing block boundaries here prevents a later concatenated frame from
  // bypassing the window/content-size checks.
  let frameOffset = 0;
  let frameCount = 0;
  while (frameOffset < encoded.length) {
    if (encoded.length - frameOffset < 5 || encoded[frameOffset] !== 0x28 || encoded[frameOffset + 1] !== 0xb5 || encoded[frameOffset + 2] !== 0x2f || encoded[frameOffset + 3] !== 0xfd) throw new AphroditeError('DECOMPRESSION_FAILED', 'Canvas chunk contains an invalid or trailing Zstandard frame.');
    const flags = encoded[frameOffset + 4];
    if (flags & 0x08) throw new AphroditeError('DECOMPRESSION_FAILED', 'Zstandard frame header is invalid.');
    const singleSegment = (flags >>> 5) & 1;
    const contentSizeFlag = flags >>> 6;
    const dictionarySize = [0, 1, 2, 4][flags & 3];
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
    let offset = frameOffset + 5;
    const windowDescriptor = singleSegment ? undefined : encoded[offset++];
    if (!singleSegment && windowDescriptor === undefined) throw new AphroditeError('DECOMPRESSION_FAILED', 'Zstandard frame window descriptor is truncated.');
    offset += dictionarySize;
    if (offset + contentSizeBytes > encoded.length) throw new AphroditeError('DECOMPRESSION_FAILED', 'Zstandard frame content size is truncated.');
    let contentSize = 0n;
    for (let index = 0; index < contentSizeBytes; index++) contentSize |= BigInt(encoded[offset + index]) << BigInt(index * 8);
    if (contentSizeFlag === 1 && contentSizeBytes === 2) contentSize += 256n;
    offset += contentSizeBytes;
    const windowBase = windowDescriptor === undefined ? 0 : 2 ** (10 + (windowDescriptor >>> 3));
    const window = singleSegment ? Number(contentSize) : windowBase + Math.floor(windowBase / 8) * ((windowDescriptor ?? 0) & 7);
    if (!Number.isSafeInteger(window) || window > maxOutput || contentSize > BigInt(maxOutput)) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Zstandard frame declares an output window beyond its configured limit.', { resource: 'inflated canvas chunk', limit: maxOutput, window, contentSize: contentSize.toString(), frame: frameCount });
    let last = false;
    let declaredOutput = 0;
    while (!last) {
      if (offset + 3 > encoded.length) throw new AphroditeError('DECOMPRESSION_FAILED', 'Zstandard frame block header is truncated.');
      const block = encoded[offset] | (encoded[offset + 1] << 8) | (encoded[offset + 2] << 16);
      last = (block & 1) === 1;
      const blockType = (block >>> 1) & 3;
      const blockSize = block >>> 3;
      if (blockType === 3) throw new AphroditeError('DECOMPRESSION_FAILED', 'Zstandard frame contains a reserved block type.');
      offset += 3;
      // Raw and compressed blocks store their payload size in the header. RLE
      // blocks are different: the header stores the decompressed byte count,
      // while the on-disk payload is exactly one repeated byte.
      const payloadSize = blockType === 1 ? 1 : blockSize;
      if (offset + payloadSize > encoded.length) throw new AphroditeError('DECOMPRESSION_FAILED', 'Zstandard frame block is truncated.');
      if (blockType === 0 || blockType === 1) {
        declaredOutput += blockSize;
        if (!Number.isSafeInteger(declaredOutput) || declaredOutput > maxOutput) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Zstandard frame declares an output size beyond its configured limit.', { resource: 'inflated canvas chunk', limit: maxOutput });
      }
      offset += payloadSize;
    }
    if (flags & 4) { if (offset + 4 > encoded.length) throw new AphroditeError('DECOMPRESSION_FAILED', 'Zstandard content checksum is truncated.'); offset += 4; }
    frameOffset = offset;
    frameCount++;
  }
  if (!frameCount) throw new AphroditeError('DECOMPRESSION_FAILED', 'Canvas chunk did not contain a Zstandard frame.');
}

function inflateZstdBounded(encoded: Uint8Array, signal: AbortSignal | undefined, maxOutput: number) {
  zstdFrameBounds(encoded, maxOutput);
  const chunks: Uint8Array[] = []; let total = 0;
  const decompressor = new ZstdDecompress((chunk) => { checkAbort(signal); total += chunk.byteLength; if (total > maxOutput) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Inflated canvas chunk exceeded its limit.', { resource: 'inflated canvas chunk', observed: total, limit: maxOutput }); chunks.push(new Uint8Array(chunk)); });
  try { decompressor.push(encoded, true); } catch (error) { if (error instanceof AphroditeError) throw error; throw new AphroditeError('DECOMPRESSION_FAILED', 'Canvas Zstandard decompression failed.', { cause: error instanceof Error ? error.message : String(error) }); }
  const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; } return output;
}

function boundedDecompress(encoded: Uint8Array, signal?: AbortSignal, maxOutput = LIMITS.maxInflatedChunkBytes) {
  checkAbort(signal);
  try {
    return inflateRawBounded(encoded, signal, maxOutput);
  } catch (first) {
    const zstd = encoded.length >= 4 && encoded[0] === 0x28 && encoded[1] === 0xb5 && encoded[2] === 0x2f && encoded[3] === 0xfd;
    if (!zstd) throw first;
    try {
      return inflateZstdBounded(encoded, signal, maxOutput);
    } catch (second) {
      if (second instanceof AphroditeError) throw second;
      throw new AphroditeError('DECOMPRESSION_FAILED', 'Canvas chunk decompression failed.', { cause: first instanceof Error ? first.message : String(first) });
    }
  }
}

function decodeRawCanvas(bytes: Uint8Array, signal?: AbortSignal): DecodedCanvas {
  if (bytes.byteLength < 12) throw new AphroditeError('INVALID_HEADER', 'Canvas input is shorter than its header.');
  const header = new TextDecoder().decode(bytes.subarray(0, 8));
  if (header !== 'fig-kiwi' && header !== 'fig-jam.') throw new AphroditeError('INVALID_HEADER', `Unsupported canvas header ${JSON.stringify(header)}.`);
  const version = u32(bytes, 8); if (version !== 106) throw new AphroditeError('UNSUPPORTED_FORMAT_VERSION', `Canvas version ${version} is unsupported.`, { supported: [106], received: version });
  const chunks: Uint8Array[] = []; let offset = 12;
  while (offset < bytes.byteLength) {
    checkAbort(signal); const size = u32(bytes, offset); offset += 4;
    if (size > LIMITS.maxEncodedChunkBytes || offset + size > bytes.byteLength) throw new AphroditeError('ARCHIVE_MALFORMED', 'Canvas chunk length is outside the source bounds.', { size, limit: LIMITS.maxEncodedChunkBytes });
    chunks.push(bytes.subarray(offset, offset + size)); offset += size;
  }
  if (chunks.length < 2) throw new AphroditeError('CANVAS_MISSING', 'Canvas archive did not contain schema and data chunks.');
  try {
    const schemaBytes = boundedDecompress(chunks[0], signal, Math.min(LIMITS.maxInflatedChunkBytes, LIMITS.maxInflatedCanvasBytes));
    const dataBytes = boundedDecompress(chunks[1], signal, Math.min(LIMITS.maxInflatedChunkBytes, LIMITS.maxInflatedCanvasBytes - schemaBytes.byteLength));
    if (schemaBytes.byteLength + dataBytes.byteLength > LIMITS.maxInflatedCanvasBytes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Inflated canvas data exceeded its limit.', { resource: 'inflated schema/data', limit: LIMITS.maxInflatedCanvasBytes });
    const schema = kiwi.compileSchema(kiwi.decodeBinarySchema(schemaBytes));
    const decoded = schema.decodeMessage(dataBytes) as { nodeChanges?: unknown[]; blobs?: unknown[] };
    validateDecodedStrings(decoded);
    if (!Array.isArray(decoded.nodeChanges) || decoded.nodeChanges.length === 0) throw new AphroditeError('DOCUMENT_INVALID', 'Decoded canvas did not contain node changes.');
    if (decoded.nodeChanges.length > LIMITS.maxNodes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Decoded node count exceeded its limit.', { observed: decoded.nodeChanges.length, limit: LIMITS.maxNodes });
    const nodes = new Map<string, any>();
    const parents = new Map<string, string | null>();
    for (const node of decoded.nodeChanges as any[]) {
      if (!node?.guid) throw new AphroditeError('DOCUMENT_INVALID', 'Decoded node is missing its GUID.');
      const id = canonicalGuid(node.guid);
      if (nodes.has(id)) throw new AphroditeError('DUPLICATE_NODE_ID', `Duplicate node ID ${id}.`, { id });
      nodes.set(id, node);
    }
    for (const [id, node] of nodes) {
      const parentValue = node.parentIndex?.guid;
      if (id === '0:0') {
        if (parentValue !== undefined) throw new AphroditeError('INVALID_PARENT', 'Root node cannot have a parent.', { id });
        parents.set(id, null);
        continue;
      }
      if (parentValue === undefined) throw new AphroditeError('INVALID_PARENT', `Node ${id} is missing its parent evidence.`, { id });
      const parentId = canonicalGuid(parentValue);
      if (parentId === id) throw new AphroditeError('GRAPH_CYCLE', `Graph cycle includes ${id}.`, { id });
      if (!nodes.has(parentId)) throw new AphroditeError('INVALID_PARENT', `Node ${id} references a missing parent.`, { id, parentId });
      parents.set(id, parentId);
    }
    const colors = new Map<string, 0 | 1 | 2>();
    for (const id of nodes.keys()) {
      if ((colors.get(id) ?? 0) === 2) continue;
      let current: string | null = id;
      const path = new Set<string>();
      while (current) {
        const color = colors.get(current) ?? 0;
        if (color === 2) break;
        if (path.has(current) || color === 1) throw new AphroditeError('GRAPH_CYCLE', `Graph cycle includes ${current}.`, { id: current });
        path.add(current); colors.set(current, 1); current = parents.get(current) ?? null;
      }
      for (const visited of path) colors.set(visited, 2);
    }
    for (const node of nodes.values()) node.children = [];
    for (const [id, parentId] of parents) if (parentId) nodes.get(parentId)!.children.push(nodes.get(id));
    const root = nodes.get('0:0'); if (!root) throw new AphroditeError('DOCUMENT_INVALID', 'Decoded canvas did not contain root node 0:0.');
    return { version, root, blobs: decoded.blobs ?? [] };
  } catch (error) { if (error instanceof AphroditeError) throw error; throw new AphroditeError('DOCUMENT_INVALID', 'Kiwi canvas decoding failed.', { cause: error instanceof Error ? error.message : String(error) }); }
}

function canonicalGuid(guid: any) {
  const asUnsigned = (value: unknown) => {
    const text = typeof value === 'bigint' ? value.toString() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
    if (text === undefined) throw new AphroditeError('DOCUMENT_INVALID', 'Canvas contained an invalid node GUID.');
    const integer = BigInt(text);
    if (integer < 0n || integer > 0xffffffffn) throw new AphroditeError('DOCUMENT_INVALID', 'Canvas contained an out-of-range node GUID.');
    return integer.toString();
  };
  return `${asUnsigned(guid?.sessionID)}:${asUnsigned(guid?.localID)}`;
}
function decodeJson(bytes: Uint8Array): DecodedCanvas {
  let value: any; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch (error) { throw new AphroditeError('DOCUMENT_INVALID', 'Input is not valid JSON.', { cause: error instanceof Error ? error.message : String(error) }); }
  validateDecodedStrings(value);
  const version = Number(value?.version ?? value?.figVersion); if (version !== 106) throw new AphroditeError('UNSUPPORTED_FORMAT_VERSION', `Canvas version ${version} is unsupported.`, { supported: [106], received: version });
  if (!value?.root || !Array.isArray(value?.blobs ?? [])) throw new AphroditeError('DOCUMENT_INVALID', 'JSON canvas must contain root and blobs.');
  return { version, root: value.root, blobs: value.blobs ?? [] };
}

function readEntry(zip: ZipFile, entry: Entry, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    if (entry.uncompressedSize > LIMITS.maxExpandedEntryBytes || (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > LIMITS.maxCompressionRatio && entry.uncompressedSize > 1 * 1024 * 1024)) { reject(new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'ZIP entry expansion exceeded its limit.', { entry: entry.fileName })); return; }
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(error ?? new Error('No entry stream')); return; }
      const chunks: Buffer[] = []; let total = 0;
      stream.on('data', (chunk: Buffer) => { if (signal?.aborted) { stream.destroy(); reject(new AphroditeError('IMPORT_CANCELLED', 'Import was cancelled.')); return; } total += chunk.byteLength; if (total > LIMITS.maxExpandedEntryBytes) { stream.destroy(); reject(new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'ZIP entry exceeded expanded-size limit.', { entry: entry.fileName })); return; } chunks.push(chunk); });
      stream.on('error', reject); stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
  });
}

function readZip(bytes: Uint8Array, signal?: AbortSignal): Promise<{ canvas: Uint8Array; images: Map<string, Uint8Array> }> {
  return new Promise((resolve, reject) => {
    fromBuffer(Buffer.from(bytes), { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) { reject(new AphroditeError('ARCHIVE_MALFORMED', 'Input is not a readable ZIP archive.', { cause: error?.message })); return; }
      const images = new Map<string, Uint8Array>(); let canvas: Uint8Array | undefined; let count = 0; let total = 0; let canvasCount = 0;
      const fail = (cause: unknown) => { zip.close(); reject(cause instanceof AphroditeError ? cause : new AphroditeError('ARCHIVE_MALFORMED', 'ZIP entry processing failed.', { cause: cause instanceof Error ? cause.message : String(cause) })); };
      zip.on('entry', async (entry: Entry) => {
        try {
          checkAbort(signal); count++; if (count > LIMITS.maxZipEntries) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'ZIP entry count exceeded its limit.', { limit: LIMITS.maxZipEntries });
          const name = entry.fileName;
          const parts = name.split('/');
          const unsafePath = name.includes('\\') || name.startsWith('/') || parts.some((part, index) => part === '..' || (part === '' && index !== parts.length - 1));
          if (unsafePath) throw new AphroditeError('ARCHIVE_MALFORMED', `Unsafe ZIP path ${name}.`);
          if (name.endsWith('/')) { zip.readEntry(); return; }
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000; if (mode === 0xa000) throw new AphroditeError('ARCHIVE_MALFORMED', `ZIP symlink ${name} is not allowed.`);
          const isCanvas = name === 'canvas.fig'; const imageMatch = /^images\/([0-9a-f]{40})$/.exec(name); if (!isCanvas && !imageMatch) { zip.readEntry(); return; }
          if (isCanvas) canvasCount++;
          const data = await readEntry(zip, entry, signal); total += data.byteLength; if (total > LIMITS.maxExpandedZipBytes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'ZIP expanded bytes exceeded their limit.', { limit: LIMITS.maxExpandedZipBytes });
          if (isCanvas) canvas = data; else if (imageMatch) { if (images.has(imageMatch[1])) throw new AphroditeError('ARCHIVE_MALFORMED', `Duplicate image entry ${name}.`); images.set(imageMatch[1], data); } zip.readEntry();
        } catch (cause) { fail(cause); }
      });
      zip.on('end', () => { if (canvasCount !== 1 || !canvas) { reject(new AphroditeError('CANVAS_MISSING', 'ZIP archive must contain exactly one canvas.fig entry.')); return; } resolve({ canvas, images }); });
      zip.on('error', error2 => fail(error2));
      zip.readEntry();
    });
  });
}

async function readSourceFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const metadata = await stat(path);
  if (metadata.size > LIMITS.maxSourceBytes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Source file exceeded its limit.', { observed: metadata.size, limit: LIMITS.maxSourceBytes });
  const handle = await open(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      checkAbort(signal);
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, LIMITS.maxSourceBytes - total + 1)));
      const result = await handle.read(buffer, 0, buffer.byteLength, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > LIMITS.maxSourceBytes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Source file exceeded its limit.', { observed: total, limit: LIMITS.maxSourceBytes });
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
  } finally { await handle.close(); }
  return new Uint8Array(Buffer.concat(chunks, total));
}

export async function parseContainer(input: ImportInput, signal?: AbortSignal): Promise<ContainerInput> {
  const sourceName = typeof input === 'string' ? basename(input) : undefined;
  const raw = typeof input === 'string' ? await readSourceFile(input, signal) : bytesOf(input);
  const bytes = new Uint8Array(raw);
  if (bytes.byteLength > LIMITS.maxSourceBytes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Source file exceeded its limit.', { observed: bytes.byteLength, limit: LIMITS.maxSourceBytes });
  checkAbort(signal);
  if (bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) { const archive = await readZip(bytes, signal); return { sourceBytes: bytes, sourceName, canvas: decodeRawCanvas(archive.canvas, signal), images: archive.images, format: 'zip' }; }
  const prefix = new TextDecoder().decode(bytes.subarray(0, 8)); if (prefix === 'fig-kiwi' || prefix === 'fig-jam.') return { sourceBytes: bytes, sourceName, canvas: decodeRawCanvas(bytes, signal), images: new Map(), format: 'raw' };
  if (bytes[0] === 0x7b || bytes[0] === 0x5b) return { sourceBytes: bytes, sourceName, canvas: decodeJson(bytes), images: new Map(), format: 'json' };
  throw new AphroditeError('INVALID_HEADER', 'Input is neither a supported .fig archive, canvas, nor JSON snapshot.');
}
