import { describe, expect, it } from 'vitest';
import { parseFigmaFileRef, parseFigmaNodeId } from '../../src/context/figma-url.js';
import { commandsToSvg, decodeCommands, decodeVectorNetwork, nodeSvgPaint } from '../../src/import/blobs.js';
import { zstdFrameBounds } from '../../src/import/fig-container.js';
import { extractAssets } from '../../src/import/assets.js';
import { normalizeGraph } from '../../src/import/graph.js';
import { AssetV1 } from '../../src/contracts/v1.js';
import { importDocument } from '../../src/import/import-document.js';
import { DesignStore } from '../../src/context/extract.js';
import { readImportedDocument } from '../../src/import/import-document.js';
import { initProject } from '../../src/core/project.js';
import { runCli } from '../../src/cli.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: { write: (value: string) => { stdout.push(value); return true; } } as any, stderr: { write: (value: string) => { stderr.push(value); return true; } } as any }, stdout, stderr };
}

describe('hardening regressions', () => {
  it('extracts image paints from parser-shaped fillPaints', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-assets-'));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const hash = createHash('sha1').update(bytes).digest('hex');
    const raw = { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [{ guid: { sessionID: 1, localID: 1 }, type: 'RECTANGLE', fillPaints: [{ type: 'IMAGE', visible: true, image: { hash: Array.from(Buffer.from(hash, 'hex')) } }], children: [] }] };
    const graph = normalizeGraph(raw);
    const extraction = await extractAssets(graph, [], new Map([[hash, bytes]]), join(project, 'assets'));
    expect(extraction.records).toContainEqual(expect.objectContaining({ canonicalNodeId: '1:1', kind: 'raster', status: 'resolved', rawReference: hash }));
  });

  it('only resolves geometry when a safe solid paint is available', () => {
    const bytes = new Uint8Array(19);
    const view = new DataView(bytes.buffer);
    bytes[0] = 1; view.setFloat32(1, 0, true); view.setFloat32(5, 0, true);
    bytes[9] = 2; view.setFloat32(10, 10, true); view.setFloat32(14, 0, true);
    bytes[18] = 0;
    const path = decodeCommands(bytes);
    expect(commandsToSvg(path)).toBeUndefined();
    const paint = nodeSvgPaint({ fillPaints: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 } }] });
    expect(commandsToSvg(path, '0 0 10 10', paint)).toContain('fill="rgb(255, 0, 0)"');
  });

  it('preflights a valid zstd RLE block by its one-byte payload', () => {
    // Single-segment frame, 5-byte content size, final RLE block whose header
    // declares five output bytes but stores only one repeated byte on disk.
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x05, 0x2b, 0x00, 0x00, 0x41]);
    expect(() => zstdFrameBounds(frame, 16)).not.toThrow();
    expect(() => zstdFrameBounds(frame, 4)).toThrowError(/limit/i);
  });

  it('rejects traversal-like cache asset paths', () => {
    const base = { canonicalNodeId: '1:2', rawReference: 'asset', kind: 'raster', status: 'resolved', mustCopyToTrackedProject: true } as const;
    expect(() => AssetV1.parse({ ...base, cacheSourcePath: 'assets/raster/.' })).toThrow();
    expect(() => AssetV1.parse({ ...base, cacheSourcePath: 'assets/raster/..' })).toThrow();
    expect(() => AssetV1.parse({ ...base, cacheSourcePath: 'assets/raster/../asset.png' })).toThrow();
  });

  it('turns malformed URI decoding into stable Aphrodite errors', () => {
    expect(() => parseFigmaNodeId('%E0%A4%A')).toThrowError(/malformed percent-encoding/i);
    expect(() => parseFigmaFileRef('https://figma.com/design/%E0%A4%A/Handoff')).toThrowError(/malformed percent-encoding/i);
  });

  it('bounds vector counts before allocation and rejects malformed loop data', () => {
    const hugeHeader = new Uint8Array([...u32(0xffff_ffff), ...u32(0), ...u32(0)]);
    expect(() => decodeVectorNetwork(hugeHeader)).toThrowError(/limit/i);
    const hugeLoop = new Uint8Array([...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0xffff_ffff)]);
    expect(() => decodeVectorNetwork(hugeLoop)).toThrowError(/limit/i);
  });

  it('rejects unsafe cache import IDs before joining paths', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-cache-'));
    await initProject(project);
    await expect(readImportedDocument(project, '../outside')).rejects.toMatchObject({ code: 'DOCUMENT_INVALID' });
    await expect(readImportedDocument(project, 'A'.repeat(64))).rejects.toMatchObject({ code: 'DOCUMENT_INVALID' });
  });

  it('rejects conflicting CLI references and unsafe numeric options', async () => {
    let output = capture();
    expect(await runCli(['inspect', '--url', 'https://figma.com/design/FILE/Handoff?node-id=1-1', '--alias', 'fixture', '--json'], output.io)).toBe(2);
    expect(JSON.parse(output.stdout.join('')).error.code).toBe('URL_INVALID');
    output = capture();
    expect(await runCli(['inspect', '--alias', 'fixture', '--depth', '9007199254740992', '--json'], output.io)).toBe(2);
    expect(JSON.parse(output.stdout.join('')).error.code).toBe('RESOURCE_LIMIT_EXCEEDED');
  });

  it('fails malformed command blobs and zero-node context budgets', async () => {
    expect(() => decodeCommands(new Uint8Array([255]))).toThrowError(/unknown command opcode/i);
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-budget-'));
    await initProject(project);
    const source = join(project, 'budget.json');
    await writeFile(source, JSON.stringify({ version: 106, blobs: [], root: { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [{ guid: { sessionID: 1, localID: 1 }, type: 'FRAME', name: 'Target', children: [] }] } }));
    await importDocument(source, { projectRoot: project, alias: 'budget' });
    await expect(new DesignStore(project).getNodeContext({ alias: 'budget', nodeId: '1:1' }, { maxNodes: 0 })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
  });

  it('rejects decoded string payloads beyond the global string budget', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-strings-'));
    await initProject(project);
    const source = join(project, 'strings.json');
    const oversized = 'x'.repeat(1_048_577);
    const root = { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', name: oversized, children: [] };
    await writeFile(source, JSON.stringify({ version: 106, blobs: [], root }));
    await expect(importDocument(source, { projectRoot: project })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
  });
});
