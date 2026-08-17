import { AphroditeError } from '../core/errors.js';
import { FileRefV1, NodeRefV1, type FileRefV1 as FileRef, type NodeRefV1 as NodeRef } from '../contracts/v1.js';

export interface ParsedFileRef {
  fileKey?: string;
  alias?: string;
}

export interface ParsedNodeRef extends ParsedFileRef {
  nodeId: string;
}

const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new AphroditeError('URL_INVALID', message, details);
}
function decode(value: string, code: 'URL_INVALID' | 'NODE_ID_INVALID', message: string): string {
  try { return decodeURIComponent(value); } catch { throw new AphroditeError(code, message, { value }); }
}

/** Parse the simple `session-local`/`session:local` IDs used by copied Figma links. */
export function parseFigmaNodeId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AphroditeError('NODE_ID_INVALID', 'A node ID is required.');
  }
  const decoded = decode(value, 'NODE_ID_INVALID', 'Figma node ID contains malformed percent-encoding.');
  // Figma uses semicolon-delimited IDs for instance override paths. Resolving one
  // without the original instance graph would be a guess, so make the boundary explicit.
  if (decoded.includes(';') || /^I(?:\d+[-:]\d+)?(?:;|$)/.test(decoded)) {
    throw new AphroditeError('INSTANCE_PATH_UNSUPPORTED', 'Nested Figma instance paths are not supported by the local MVP.', { nodeId: decoded });
  }
  const match = /^(\d+)[-:](\d+)$/.exec(decoded);
  if (!match) throw new AphroditeError('NODE_ID_INVALID', `Invalid Figma node ID ${decoded}.`);
  const session = BigInt(match[1]);
  const local = BigInt(match[2]);
  if (session > 0xffffffffn || local > 0xffffffffn) throw new AphroditeError('NODE_ID_INVALID', 'Figma node ID exceeds the unsigned 32-bit range.');
  return `${session}:${local}`;
}

function parseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return invalid('Malformed Figma URL.'); }
  if (url.protocol !== 'https:' || !FIGMA_HOSTS.has(url.hostname.toLowerCase())) return invalid('Figma URL must use https://figma.com or https://www.figma.com.');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || (parts[0] !== 'design' && parts[0] !== 'file')) return invalid('Figma URL must use /design/<file-key>/ or /file/<file-key>/.');
  const fileKey = decode(parts[1], 'URL_INVALID', 'Figma URL contains malformed percent-encoding.');
  if (!/^[A-Za-z0-9]+$/.test(fileKey)) return invalid('Figma file key is invalid.');
  return url;
}

function fileKeyFromUrl(value: string): { url: URL; fileKey: string } {
  const url = parseUrl(value);
  return { url, fileKey: decode(url.pathname.split('/').filter(Boolean)[1], 'URL_INVALID', 'Figma URL contains malformed percent-encoding.') };
}

export function parseFigmaFileRef(value: FileRef | string): ParsedFileRef {
  if (typeof value === 'string') {
    const { fileKey } = fileKeyFromUrl(value);
    return { fileKey };
  }
  const ref = FileRefV1.parse(value);
  if ('url' in ref) {
    const { fileKey } = fileKeyFromUrl(ref.url);
    return { fileKey };
  }
  if ('fileKey' in ref) return { fileKey: ref.fileKey };
  return { alias: ref.alias };
}

export function parseFigmaNodeRef(value: NodeRef | string): ParsedNodeRef {
  if (typeof value === 'string') {
    const { url, fileKey } = fileKeyFromUrl(value);
    const rawNode = url.searchParams.get('node-id');
    if (!rawNode) throw new AphroditeError('NODE_ID_INVALID', 'Figma node URL must include a node-id query parameter.');
    return { fileKey, nodeId: parseFigmaNodeId(rawNode) };
  }
  const ref = NodeRefV1.parse(value);
  if ('url' in ref) {
    const { url, fileKey } = fileKeyFromUrl(ref.url);
    const rawNode = url.searchParams.get('node-id');
    if (!rawNode) throw new AphroditeError('NODE_ID_INVALID', 'Figma node URL must include a node-id query parameter.');
    return { fileKey, nodeId: parseFigmaNodeId(rawNode) };
  }
  return { ...('fileKey' in ref ? { fileKey: ref.fileKey } : { alias: ref.alias }), nodeId: parseFigmaNodeId(ref.nodeId) };
}
