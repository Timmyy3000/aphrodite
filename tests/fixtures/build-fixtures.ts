import { readFile, writeFile, stat, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseContainer } from '../../src/import/fig-container.js';
import { normalizeGraph } from '../../src/import/graph.js';
import { buildIndex } from '../../src/index/build-index.js';
import { initProject } from '../../src/core/project.js';
import { importDocument } from '../../src/import/import-document.js';
import { DesignStore } from '../../src/context/extract.js';
import { LIMITS } from '../../src/core/limits.js';

const here = dirname(fileURLToPath(import.meta.url));
function node(sessionID: number, localID: number, type: string, name: string, children: any[] = []) { return { guid: { sessionID, localID }, type, name, children }; }
function vectorBlob() {
  const bytes = new Uint8Array(68); const view = new DataView(bytes.buffer); let offset = 0;
  const u32 = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
  const f32 = (value: number) => { view.setFloat32(offset, value, true); offset += 4; };
  u32(1); u32(1); u32(1); u32(0); f32(0); f32(0); u32(0); u32(0); f32(0); f32(0); u32(0); f32(0); f32(0); u32(0); u32(1); u32(1); u32(0);
  return Array.from(bytes);
}
function representativeNodes(start = 1) {
  return [
    node(1, start, 'FRAME', 'Representative frame'),
    { ...node(1, start + 1, 'TEXT', 'Representative text'), textData: { characters: 'Aphrodite fixture text', lines: [{ start: 0, end: 22 }] } },
    { ...node(1, start + 2, 'SYMBOL', 'Card component'), symbolData: { symbolID: { sessionID: 1, localID: start + 2 } } },
    { ...node(1, start + 3, 'INSTANCE', 'Card instance'), symbolData: { symbolID: { sessionID: 1, localID: start + 2 } } },
    { ...node(1, start + 4, 'RECTANGLE', 'Image placeholder'), imageRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { ...node(1, start + 5, 'VECTOR', 'Vector icon'), vectorNetworkBlob: 0, fillPaints: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } }] },
  ];
}
export function makeCorrectnessFixture() { return { version: 106, root: { ...node(0, 0, 'DOCUMENT', 'Document'), children: [node(1, 1_000_000, 'CANVAS', 'Page 1', representativeNodes())] }, blobs: [vectorBlob()] }; }
export function makePerformanceFixture(count = 5000) {
  const representatives = representativeNodes();
  const remaining = Array.from({ length: Math.max(0, count - representatives.length) }, (_, index) => node(1, index + representatives.length + 1, index % 17 === 0 ? 'FRAME' : 'RECTANGLE', `Node ${index + representatives.length + 1}`));
  const children = [...representatives, ...remaining];
  return { version: 106, root: { ...node(0, 0, 'DOCUMENT', 'Performance'), children: [node(1, 1_000_000, 'CANVAS', 'Page 1', children)] }, blobs: [vectorBlob()] };
}
function assertFixtureCoverage(result: Awaited<ReturnType<typeof parseContainer>>, label: string) {
  const graph = normalizeGraph(result.canvas.root);
  const values = [...graph.nodes.values()].map(item => item.raw);
  const types = new Set(values.map(raw => String(raw.type ?? raw.nodeType ?? '')));
  if (!types.has('TEXT') || !types.has('INSTANCE') || !types.has('SYMBOL')) throw new Error(`${label} fixture must include text and component/instance nodes.`);
  if (!values.some(raw => typeof raw.imageRef === 'string')) throw new Error(`${label} fixture must include an image reference.`);
  if (!values.some(raw => raw.vectorNetworkBlob !== undefined) || result.canvas.blobs.length < 1) throw new Error(`${label} fixture must include a vector blob.`);
  return graph;
}
async function verify(path: string) { const result = await parseContainer(path); const graph = assertFixtureCoverage(result, path); const index = buildIndex(graph); if (index.records.length < 2 || index.records[0].id !== '0:0') throw new Error('Generated fixture index is invalid'); return index.records.length; }
if (process.argv.includes('--verify')) { const fixture = join(here, 'generated', 'correctness-v106.json'); const count = await verify(fixture); console.log(`Generated fixture verified (${count} nodes).`); }
if (process.argv.includes('--verify-performance')) {
  const fixture = join(here, 'performance', 'performance-v106.json');
  const parsedFixture = await parseContainer(fixture);
  assertFixtureCoverage(parsedFixture, fixture);
  const project = await mkdtemp(join(tmpdir(), 'aphrodite-performance-'));
  const importStarted = performance.now();
  await initProject(project);
  const imported = await importDocument(fixture, { projectRoot: project, alias: 'performance-fixture' });
  const importMs = performance.now() - importStarted;
  if (imported.manifest.nodeCount < 5000) throw new Error(`Performance fixture must contain at least 5,000 nodes (got ${imported.manifest.nodeCount}).`);
  const store = new DesignStore(project);
  const samples: number[] = [];
  let serializedBytes = 0;
  for (let repeat = 0; repeat < 5; repeat++) {
    const started = performance.now();
    const screens = await store.listScreens({ alias: 'performance-fixture' });
    const context = await store.getNodeContext({ alias: 'performance-fixture', nodeId: '1:1' }, { depth: 2, maxNodes: 64, maxTextUnits: 1024 });
    const screensBytes = Buffer.byteLength(JSON.stringify(screens), 'utf8');
    const contextBytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    serializedBytes = screensBytes + contextBytes;
    if (screensBytes > LIMITS.maxSerializedResponseBytes || contextBytes > LIMITS.maxSerializedResponseBytes) throw new Error(`Performance query payload exceeded its per-response cap (${screensBytes} + ${contextBytes} bytes).`);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`Performance import/index/query verified (${imported.manifest.nodeCount} nodes, import ${importMs.toFixed(1)} ms, warm query median ${median.toFixed(1)} ms, serialized ${serializedBytes} bytes, repeats ${samples.length}).`);
}
if (process.argv.includes('--generate-correctness')) { const path = join(here, 'generated', 'correctness-v106.json'); await writeFile(path, JSON.stringify(makeCorrectnessFixture()) + '\n'); console.log(`Wrote ${path}`); }
if (process.argv.includes('--generate-performance')) { const path = join(here, 'performance', 'performance-v106.json'); await writeFile(path, JSON.stringify(makePerformanceFixture()) + '\n'); console.log(`Wrote ${path}`); }
if (process.argv.includes('--verify-external')) {
  const fixtureArg = process.argv.indexOf('--fixture');
  const positionalFixture = process.argv.slice(process.argv.indexOf('--verify-external') + 1).find(value => !value.startsWith('--'));
  const fixture = fixtureArg >= 0 ? process.argv[fixtureArg + 1] : positionalFixture;
  if (!fixture) { console.error('Optional external fixture check requires --fixture <path>.'); process.exitCode = 2; }
  else try { await stat(fixture); }
  catch { console.error(`Optional external fixture not found; pass --fixture <path> (looked for ${fixture})`); process.exitCode = 2; }
  if (fixture && process.exitCode !== 2) {
    const started = performance.now();
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-external-'));
    await initProject(project);
    const imported = await importDocument(fixture, { projectRoot: project, alias: 'external-local', sourceName: 'local user-supplied .fig' });
    const elapsed = performance.now() - started;
    if (imported.manifest.nodeCount < 1) throw new Error('Optional external fixture produced no nodes.');
    const rasterRecords = imported.assets.records.filter(record => record.kind === 'raster' && record.status === 'resolved');
    if (!rasterRecords.length) throw new Error('Optional external fixture produced no resolved raster records.');
    console.log(`Optional external .fig fixture verified (${imported.manifest.nodeCount} nodes, ${imported.assets.records.length} asset records, ${rasterRecords.length} resolved raster records, ${elapsed.toFixed(1)} ms).`);
  }
}
