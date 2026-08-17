#!/usr/bin/env node
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AphroditeError, asAphroditeError } from './core/errors.js';
import { initProject } from './core/project.js';
import { importDocument } from './import/import-document.js';
import { DesignStore } from './context/extract.js';
import { FileRefV1, NodeRefV1 } from './contracts/v1.js';
import { startMcpServer } from './mcp.js';
import { LIMITS } from './core/limits.js';

export interface CliIO { stdout?: Writable; stderr?: Writable; }

const OPTIONS = {
  project: { type: 'string' as const },
  json: { type: 'boolean' as const },
  alias: { type: 'string' as const },
  'file-key': { type: 'string' as const },
  url: { type: 'string' as const },
  'node-id': { type: 'string' as const },
  depth: { type: 'string' as const },
  'max-nodes': { type: 'string' as const },
  'max-text-units': { type: 'string' as const },
  'replace-registration': { type: 'boolean' as const },
};

function out(io: CliIO, value: string) { (io.stdout ?? process.stdout).write(`${value}\n`); }
function err(io: CliIO, value: string) { (io.stderr ?? process.stderr).write(`${value}\n`); }
function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', `--${name} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', `--${name} exceeds the safe integer range.`);
  const limits: Record<string, number> = { depth: LIMITS.maxContextDepth, 'max-nodes': LIMITS.maxContextNodes, 'max-text-units': LIMITS.maxTextUnitsPerResponse };
  if (limits[name] !== undefined && parsed > limits[name]) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', `--${name} exceeds its supported limit.`, { option: name, observed: parsed, limit: limits[name] });
  return parsed;
}
function stringOption(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

function fileRef(values: Record<string, unknown>) {
  const candidates = [values.url ? { url: String(values.url) } : undefined, values['file-key'] ? { fileKey: String(values['file-key']) } : undefined, values.alias ? { alias: String(values.alias) } : undefined].filter(Boolean);
  if (candidates.length !== 1) throw new AphroditeError('URL_INVALID', 'Provide exactly one of --url, --file-key, or --alias.');
  return FileRefV1.parse(candidates[0]);
}

function nodeRef(values: Record<string, unknown>) {
  if (values.url) return NodeRefV1.parse({ url: String(values.url) });
  const nodeId = values['node-id'];
  if (!nodeId) throw new AphroditeError('NODE_ID_INVALID', 'inspect context requires --node-id or a URL containing node-id.');
  if (values['file-key']) return NodeRefV1.parse({ fileKey: String(values['file-key']), nodeId: String(nodeId) });
  if (values.alias) return NodeRefV1.parse({ alias: String(values.alias), nodeId: String(nodeId) });
  throw new AphroditeError('URL_INVALID', 'Provide --url, or pair --node-id with --file-key/--alias.');
}

function assertInspectRefFlags(values: Record<string, unknown>) {
  const hasUrl = typeof values.url === 'string';
  const hasFileKey = typeof values['file-key'] === 'string';
  const hasAlias = typeof values.alias === 'string';
  const hasNodeId = typeof values['node-id'] === 'string';
  if (hasUrl && (hasFileKey || hasAlias || hasNodeId)) throw new AphroditeError('URL_INVALID', 'Do not combine --url with --file-key, --alias, or --node-id.');
  if (hasFileKey && hasAlias) throw new AphroditeError('URL_INVALID', 'Choose exactly one of --file-key or --alias.');
  if (hasNodeId && !hasUrl && !hasFileKey && !hasAlias) throw new AphroditeError('URL_INVALID', '--node-id must be paired with --file-key or --alias.');
  if (!hasNodeId && !hasUrl && (hasFileKey || hasAlias)) return;
  if (!hasNodeId && !hasUrl) throw new AphroditeError('URL_INVALID', 'inspect requires a file reference.');
}

function exitFor(error: AphroditeError): number {
  if (['PROJECT_NOT_INITIALIZED', 'URL_INVALID', 'NODE_ID_INVALID', 'INSTANCE_PATH_UNSUPPORTED', 'DOCUMENT_NOT_IMPORTED', 'NODE_NOT_FOUND', 'RESOURCE_LIMIT_EXCEEDED'].includes(error.code)) return 2;
  if (['ARCHIVE_MALFORMED', 'CANVAS_MISSING', 'INVALID_HEADER', 'UNSUPPORTED_FORMAT_VERSION', 'DECOMPRESSION_FAILED', 'DOCUMENT_INVALID', 'DUPLICATE_NODE_ID', 'INVALID_PARENT', 'GRAPH_CYCLE', 'UNREACHABLE_NODE', 'BLOB_INVALID', 'ASSET_HASH_MISMATCH', 'TEXT_STYLE_INVALID'].includes(error.code)) return 3;
  if (['CACHE_BUSY', 'CACHE_HASH_COLLISION', 'REGISTRY_COLLISION', 'CACHE_SCHEMA_UNSUPPORTED'].includes(error.code)) return 4;
  return 1;
}

export async function runCli(argv: string[] = process.argv.slice(2), io: CliIO = {}): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (cause) {
    const error = asAphroditeError(cause, 'Invalid command-line arguments.');
    const json = argv.includes('--json');
    if (json) out(io, JSON.stringify(error.envelope())); else err(io, error.message);
    return exitFor(error);
  }
  const command = parsed.positionals[0];
  const projectRoot = String(parsed.values.project ?? process.cwd());
  const json = parsed.values.json === true;
  try {
    if (command === 'init') {
      const paths = await initProject(projectRoot);
      const result = { schemaVersion: 1, projectRoot: paths.projectRoot, cacheRoot: paths.cacheRoot };
      if (json) out(io, JSON.stringify(result)); else out(io, `Initialized Aphrodite cache at ${paths.cacheRoot}`);
      return 0;
    }
    if (command === 'import') {
      const source = parsed.positionals[1];
      if (!source) throw new AphroditeError('DOCUMENT_INVALID', 'import requires a source .fig or canvas JSON path.');
      const imported = await importDocument(source, { projectRoot, alias: parsed.values.alias ? String(parsed.values.alias) : undefined, fileKey: parsed.values['file-key'] ? String(parsed.values['file-key']) : undefined, replaceRegistration: parsed.values['replace-registration'] === true, sourceName: source });
      const result = { schemaVersion: 1, importId: imported.importId, formatVersion: imported.manifest.formatVersion, nodeCount: imported.manifest.nodeCount, ...(imported.manifest.fileKey ? { fileKey: imported.manifest.fileKey } : {}), ...(imported.manifest.alias ? { alias: imported.manifest.alias } : {}), assets: imported.assets.records };
      if (json) out(io, JSON.stringify(result)); else out(io, `Imported ${source} as ${imported.importId} (${imported.manifest.nodeCount} nodes)`);
      return 0;
    }
    if (command === 'inspect') {
      assertInspectRefFlags(parsed.values as Record<string, unknown>);
      const store = new DesignStore(projectRoot);
      const depth = numberOption(stringOption(parsed.values.depth), 'depth');
      const maxNodes = numberOption(stringOption(parsed.values['max-nodes']), 'max-nodes');
      const maxTextUnits = numberOption(stringOption(parsed.values['max-text-units']), 'max-text-units');
      const result = parsed.values['node-id'] || (typeof parsed.values.url === 'string' && parsed.values.url.includes('node-id=')) ? await store.getNodeContext(nodeRef(parsed.values), { depth, maxNodes, maxTextUnits }) : await store.listScreens(fileRef(parsed.values));
      if (json) out(io, JSON.stringify(result)); else out(io, JSON.stringify(result, null, 2));
      return 0;
    }
    if (command === 'mcp') {
      await startMcpServer(projectRoot);
      return 0;
    }
    throw new AphroditeError('URL_INVALID', 'Usage: aphrodite init|import|inspect|mcp [options].');
  } catch (cause) {
    const error = asAphroditeError(cause);
    if (json) out(io, JSON.stringify(error.envelope())); else err(io, error.message);
    return exitFor(error);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
