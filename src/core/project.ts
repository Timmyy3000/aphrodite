import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RootManifestV1, IMPORTER_VERSION, CACHE_SCHEMA_VERSION, CONTEXT_SCHEMA_VERSION, RAW_SCHEMA_VERSION } from '../contracts/cache-v1.js';
import { AphroditeError } from './errors.js';
export const CACHE_DIRNAME = '.aphrodite';
export interface ProjectPaths { projectRoot: string; cacheRoot: string; manifestPath: string; lockPath: string; documentsRoot: string; tmpRoot: string; }
export function projectPaths(projectRoot: string): ProjectPaths { const root = resolve(projectRoot); const cacheRoot = join(root, CACHE_DIRNAME); return { projectRoot: root, cacheRoot, manifestPath: join(cacheRoot, 'manifest.json'), lockPath: join(cacheRoot, 'manifest.lock'), documentsRoot: join(cacheRoot, 'documents'), tmpRoot: join(cacheRoot, 'tmp') }; }
function rootManifest(): RootManifestV1 { return { cacheSchemaVersion: CACHE_SCHEMA_VERSION, contextSchemaVersion: CONTEXT_SCHEMA_VERSION, rawSchemaVersion: RAW_SCHEMA_VERSION, importerVersion: IMPORTER_VERSION, supportedFigVersions: [106], registrations: {} }; }
function detectNewline(text: string) { return text.includes('\r\n') ? '\r\n' : '\n'; }
export async function initProject(projectRoot = process.cwd()): Promise<ProjectPaths> {
  const paths = projectPaths(projectRoot); await mkdir(paths.documentsRoot, { recursive: true }); await mkdir(paths.tmpRoot, { recursive: true });
  try { const existing = RootManifestV1.parse(JSON.parse(await readFile(paths.manifestPath, 'utf8'))); if (existing.cacheSchemaVersion !== 1 || existing.contextSchemaVersion !== 1 || existing.rawSchemaVersion !== 1) throw new Error('version'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AphroditeError('CACHE_SCHEMA_UNSUPPORTED', 'Existing cache manifest is incompatible; remove .aphrodite and re-run init.'); await writeJsonAtomic(paths.manifestPath, rootManifest()); }
  await ensureGitignore(paths.projectRoot); return paths;
}
export async function readProjectManifest(paths: ProjectPaths): Promise<RootManifestV1> { let raw: string; try { raw = await readFile(paths.manifestPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AphroditeError('PROJECT_NOT_INITIALIZED', 'Project is not initialized; run aphrodite init first.'); throw error; } try { return RootManifestV1.parse(JSON.parse(raw)); } catch { throw new AphroditeError('CACHE_SCHEMA_UNSUPPORTED', 'The Aphrodite cache schema is unsupported; remove .aphrodite and re-run init.'); } }
export async function writeJsonAtomic(path: string, value: unknown) { const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8'); await rename(tmp, path).catch(async error => { await unlink(tmp).catch(() => undefined); throw error; }); }
async function ensureGitignore(projectRoot: string) { const path = join(projectRoot, '.gitignore'); let text = ''; try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } const newline = detectNewline(text); const covered = text.split(/\r?\n/).some(line => ['/\.aphrodite/', '.aphrodite/', '/.aphrodite'].includes(line.trim())); if (covered) return; const prefix = text.length && !text.endsWith('\n') && !text.endsWith('\r') ? newline : ''; await writeFile(path, text + `${prefix}/.aphrodite/${newline}`, 'utf8'); }
export function cacheRelativePath(paths: ProjectPaths, absolutePath: string) { const rel = relative(paths.cacheRoot, absolutePath).replaceAll('\\', '/'); if (rel.startsWith('../') || rel === '..' || rel.startsWith('/')) throw new AphroditeError('DOCUMENT_INVALID', 'Cache path escaped project cache.'); return rel; }
