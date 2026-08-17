import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseContainer, type ImportInput } from './fig-container.js';
import { normalizeGraph } from './graph.js';
import { buildIndex } from '../index/build-index.js';
import { extractAssets } from './assets.js';
import { validateBlobs } from './blobs.js';
import { RawDocumentEnvelopeV1 } from '../contracts/raw-document-v1.js';
import { AssetsV1, DocumentManifestV1, IndexV1, RootManifestV1, IMPORTER_VERSION } from '../contracts/cache-v1.js';
import { AphroditeError } from '../core/errors.js';
import { projectPaths, readProjectManifest, writeJsonAtomic, type ProjectPaths } from '../core/project.js';
import { withManifestLock } from '../core/cache-lock.js';

export interface ImportOptions { projectRoot?: string; alias?: string; fileKey?: string; replaceRegistration?: boolean; signal?: AbortSignal; sourceName?: string; }
export interface ImportedDocument { importId: string; documentDir: string; manifest: DocumentManifestV1; index: ReturnType<typeof buildIndex>; assets: ReturnType<typeof AssetsV1.parse>; }
function hashSource(source: Uint8Array) { return createHash('sha256').update(source).digest('hex'); }
function importIdFor(source: Uint8Array) { return createHash('sha256').update(source).update(`\0${IMPORTER_VERSION}`).digest('hex'); }
function keysFor(options: Pick<ImportOptions, 'alias' | 'fileKey'>): string[] {
  return [options.alias ? `alias:${options.alias}` : undefined, options.fileKey ? `fileKey:${options.fileKey}` : undefined].filter((key): key is string => Boolean(key));
}
function documentDirFor(paths: ProjectPaths, importId: string) {
  if (!/^[a-f0-9]{64}$/.test(importId)) throw new AphroditeError('DOCUMENT_INVALID', 'Import IDs must be exactly 64 lowercase hexadecimal characters.', { importId });
  const root = resolve(paths.documentsRoot); const dir = resolve(root, importId); const escaped = relative(root, dir).startsWith('..') || resolve(root) === dir && importId !== '';
  if (escaped || relative(root, dir).includes('\\')) throw new AphroditeError('DOCUMENT_INVALID', 'Import path escaped the documents cache.');
  return dir;
}
async function loadPublished(paths: ProjectPaths, importId: string): Promise<ImportedDocument> { const dir = documentDirFor(paths, importId); const manifest = DocumentManifestV1.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))); if (manifest.importId !== importId) throw new AphroditeError('CACHE_HASH_COLLISION', 'Published document metadata does not match its import ID.', { importId }); const indexRaw = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')); let parsed: any; try { parsed = IndexV1.parse(indexRaw); } catch { throw new AphroditeError('CACHE_SCHEMA_UNSUPPORTED', 'Published document index does not match IndexV1.'); } const records = parsed.records as ReturnType<typeof buildIndex>['records']; const byId = parsed.byId as ReturnType<typeof buildIndex>['byId']; const screens = records.filter(record => { const parent = record.parentId ? byId[record.parentId] : undefined; return parent?.type === 'CANVAS' && parent.visible && (record.type === 'FRAME' || record.type === 'SECTION') && record.visible; }).map(record => ({ pageId: record.parentId!, pageName: byId[record.parentId!]?.name ?? '', node: record })); const assets = AssetsV1.parse(JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'))); return { importId, documentDir: dir, manifest, index: { schemaVersion: 1, records, byId, screens }, assets }; }
export async function importDocument(input: ImportInput, options: ImportOptions = {}): Promise<ImportedDocument> {
  const paths = projectPaths(options.projectRoot ?? process.cwd()); await readProjectManifest(paths);
  const parsed = await parseContainer(input, options.signal); const sourceHash = hashSource(parsed.sourceBytes); const importId = importIdFor(parsed.sourceBytes); const documentDir = documentDirFor(paths, importId); const existingPath = join(documentDir, 'manifest.json');
  try { const existing = DocumentManifestV1.parse(JSON.parse(await readFile(existingPath, 'utf8'))); if (existing.sourceSha256 !== sourceHash || existing.importId !== importId) throw new AphroditeError('CACHE_HASH_COLLISION', 'An immutable import ID has a different source digest.', { importId }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof AphroditeError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AphroditeError('CACHE_SCHEMA_UNSUPPORTED', 'Existing document metadata is invalid.'); }
  if (await exists(existingPath)) { const loaded = await loadPublished(paths, importId); await register(paths, loaded.manifest, options); return loaded; }
  validateBlobs(parsed.canvas.blobs);
  const graph = normalizeGraph(parsed.canvas.root, options.signal); const index = buildIndex(graph); const tmp = join(paths.tmpRoot, `${importId}-${process.pid}-${Date.now()}`); const assetsDir = join(tmp, 'assets'); await mkdir(assetsDir, { recursive: true });
  try {
    const extracted = await extractAssets(graph, parsed.canvas.blobs, parsed.images, assetsDir, options.signal); const rawEnvelope = RawDocumentEnvelopeV1.parse({ rawSchemaVersion: 1, figVersion: 106, root: parsed.canvas.root, blobs: parsed.canvas.blobs }); const manifest = DocumentManifestV1.parse({ cacheSchemaVersion: 1, contextSchemaVersion: 1, rawSchemaVersion: 1, importerVersion: IMPORTER_VERSION, importId, sourceSha256: sourceHash, formatVersion: 106, sourceName: options.sourceName ?? parsed.sourceName, fileKey: options.fileKey, alias: options.alias, nodeCount: graph.nodes.size, createdAt: new Date().toISOString(), warnings: extracted.warnings }); const assets = AssetsV1.parse({ schemaVersion: 1, records: extracted.records });
    const validatedIndex = IndexV1.parse({ schemaVersion: 1, records: index.records, byId: index.byId });
    await writeJsonAtomic(join(tmp, 'manifest.json'), manifest); await writeJsonAtomic(join(tmp, 'document.json'), rawEnvelope); await writeJsonAtomic(join(tmp, 'index.json'), validatedIndex); await writeJsonAtomic(join(tmp, 'assets.json'), assets); await rename(tmp, documentDir).catch(async error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }); await register(paths, manifest, options); return { importId, documentDir, manifest, index, assets };
  } catch (error) { await rm(tmp, { recursive: true, force: true }).catch(() => undefined); throw error; }
}
async function exists(path: string) { try { await readFile(path); return true; } catch { return false; } }
async function register(paths: ProjectPaths, manifest: DocumentManifestV1, options: ImportOptions) {
  const keys = keysFor(options);
  if (!keys.length) return;
  await withManifestLock(paths.lockPath, async () => {
    const root = await readProjectManifest(paths);
    for (const key of keys) {
      const current = root.registrations[key];
      if (current && current.importId !== manifest.importId && !options.replaceRegistration) throw new AphroditeError('REGISTRY_COLLISION', `Registration ${key} already points to another import.`, { key, current: current.importId, next: manifest.importId });
    }
    const value = { importId: manifest.importId, ...(options.fileKey ?? manifest.fileKey ? { fileKey: options.fileKey ?? manifest.fileKey } : {}), ...(options.alias ?? manifest.alias ? { alias: options.alias ?? manifest.alias } : {}) };
    const registrations = { ...root.registrations };
    for (const key of keys) registrations[key] = value;
    await writeJsonAtomic(paths.manifestPath, RootManifestV1.parse({ ...root, registrations }));
  });
}
export async function readImportedDocument(projectRoot: string, importId: string) { return loadPublished(projectPaths(projectRoot), importId); }
