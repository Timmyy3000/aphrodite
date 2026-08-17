import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/core/project.js';
import { importDocument } from '../../src/import/import-document.js';
import { readImportedDocument } from '../../src/import/import-document.js';
import { DesignStore } from '../../src/context/extract.js';
describe('project cache foundation', () => {
  it('initializes idempotently and publishes an indexed JSON import', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-')); await initProject(project); await initProject(project); const ignore = await readFile(join(project, '.gitignore'), 'utf8'); expect(ignore.match(/\/.aphrodite\//g)).toHaveLength(1);
    const source = join(process.cwd(), 'tests/fixtures/generated/correctness-v106.json'); const imported = await importDocument(source, { projectRoot: project, alias: 'fixture' }); expect(imported.index.records.some(record => record.id === '1:2')).toBe(true); expect(imported.assets.records).toEqual(expect.arrayContaining([expect.objectContaining({ canonicalNodeId: '1:5', kind: 'raster', status: 'missing' }), expect.objectContaining({ canonicalNodeId: '1:6', kind: 'svg', status: 'resolved' })])); expect(new Set(imported.assets.records.filter(record => record.cacheSourcePath).map(record => record.cacheSourcePath)).size).toBe(imported.assets.records.filter(record => record.cacheSourcePath).length); const second = await importDocument(source, { projectRoot: project, alias: 'fixture' }); expect(second.importId).toBe(imported.importId);
  });

  it('fails imports for invalid blob references instead of recording a lossy success', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-')); await initProject(project);
    const source = join(project, 'invalid-blob.json');
    await writeFile(source, JSON.stringify({ version: 106, blobs: [], root: { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [{ guid: { sessionID: 1, localID: 1 }, type: 'VECTOR', commandsBlob: 99, children: [] }] } }));
    await expect(importDocument(source, { projectRoot: project })).rejects.toMatchObject({ code: 'BLOB_INVALID' });
  });

  it('keeps valid but unsupported vector geometry explicitly unsupported', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-')); await initProject(project);
    const vector = new Uint8Array(12 + 2 * 12 + 28 + 4 + 4 + 4 + 4);
    const view = new DataView(vector.buffer); let offset = 0;
    const put = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
    const float = (value: number) => { view.setFloat32(offset, value, true); offset += 4; };
    put(2); put(1); put(1); put(0); float(0); float(0); put(0); float(10); float(0); put(0); put(0); float(0); float(0); put(1); float(0); float(0); put(0); put(1); put(1); put(0);
    const source = join(project, 'unsupported-vector.json');
    await writeFile(source, JSON.stringify({ version: 106, blobs: [Array.from(vector)], root: { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [{ guid: { sessionID: 1, localID: 1 }, type: 'VECTOR', vectorNetworkBlob: 0, children: [] }] } }));
    const imported = await importDocument(source, { projectRoot: project });
    expect(imported.assets.records).toContainEqual(expect.objectContaining({ status: 'unsupported', reasonCode: 'VECTOR_NETWORK_UNSUPPORTED' }));
  });

  it('reports the actual screen cap and descendant omissions after response fitting', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-')); await initProject(project);
    const screens = Array.from({ length: 120 }, (_, index) => ({ guid: { sessionID: 1, localID: index + 2 }, type: 'FRAME', name: `Screen ${index}`, children: [] }));
    const source = join(project, 'screens.json');
    await writeFile(source, JSON.stringify({ version: 106, blobs: [], root: { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [{ guid: { sessionID: 1, localID: 1 }, type: 'CANVAS', name: 'Page', children: screens }] } }));
    await importDocument(source, { projectRoot: project, alias: 'screens' });
    const store = new DesignStore(project);
    const listed = await store.listScreens({ alias: 'screens' });
    expect(listed.truncation.returnedNodes).toBe(100);
    expect(listed.truncation.omittedNodes).toBe(20);
    expect(listed.truncation.applied?.maxNodes).toBe(100);

    const largeName = 'x'.repeat(70_000);
    const contextSource = join(project, 'context.json');
    await writeFile(contextSource, JSON.stringify({ version: 106, blobs: [], root: { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [{ guid: { sessionID: 2, localID: 1 }, type: 'FRAME', name: 'Target', children: [{ guid: { sessionID: 2, localID: 2 }, type: 'FRAME', name: largeName, children: [{ guid: { sessionID: 2, localID: 3 }, type: 'FRAME', name: largeName, children: [] }] }, { guid: { sessionID: 2, localID: 4 }, type: 'FRAME', name: 'Small', children: [] }] }] } }));
    await importDocument(contextSource, { projectRoot: project, alias: 'context' });
    const context = await store.getNodeContext({ alias: 'context', nodeId: '2:1' }, { depth: 3, maxNodes: 4 });
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(context.truncation.omittedNodes).toBeGreaterThanOrEqual(2);
    expect(context.truncation.returnedNodes + context.truncation.omittedNodes).toBe(4);
  });

  it('rejects a corrupted published index before exposing it to readers', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-')); await initProject(project);
    const source = join(project, 'index.json');
    await writeFile(source, JSON.stringify({ version: 106, blobs: [], root: { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [] } }));
    const imported = await importDocument(source, { projectRoot: project, alias: 'index' });
    await writeFile(join(imported.documentDir, 'index.json'), JSON.stringify({ schemaVersion: 99, records: [], byId: {} }));
    await expect(readImportedDocument(project, imported.importId)).rejects.toMatchObject({ code: 'CACHE_SCHEMA_UNSUPPORTED' });
  });

  it('registers alias and file key together with atomic collision and replace semantics', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-')); await initProject(project);
    const first = join(project, 'first.json'); const second = join(project, 'second.json');
    const root = { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [] };
    await writeFile(first, JSON.stringify({ version: 106, blobs: [], root }));
    await writeFile(second, JSON.stringify({ version: 106, blobs: [], root: { ...root, name: 'Second' } }));
    const imported = await importDocument(first, { projectRoot: project, alias: 'shared', fileKey: 'FILEONE' });
    const manifest = JSON.parse(await readFile(join(project, '.aphrodite', 'manifest.json'), 'utf8'));
    expect(manifest.registrations['alias:shared'].importId).toBe(imported.importId);
    expect(manifest.registrations['fileKey:FILEONE'].importId).toBe(imported.importId);
    await expect(importDocument(second, { projectRoot: project, alias: 'shared', fileKey: 'FILETWO' })).rejects.toMatchObject({ code: 'REGISTRY_COLLISION' });
    const unchanged = JSON.parse(await readFile(join(project, '.aphrodite', 'manifest.json'), 'utf8'));
    expect(unchanged.registrations['alias:shared'].importId).toBe(imported.importId);
    expect(unchanged.registrations['fileKey:FILETWO']).toBeUndefined();
    const replaced = await importDocument(second, { projectRoot: project, alias: 'shared', fileKey: 'FILETWO', replaceRegistration: true });
    const replacedManifest = JSON.parse(await readFile(join(project, '.aphrodite', 'manifest.json'), 'utf8'));
    expect(replacedManifest.registrations['alias:shared'].importId).toBe(replaced.importId);
    expect(replacedManifest.registrations['fileKey:FILETWO'].importId).toBe(replaced.importId);
  });
});
