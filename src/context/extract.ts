import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AssetsV1, type CacheAssetRecordV1, DocumentManifestV1 } from '../contracts/cache-v1.js';
import { ContextBudgetV1, DesignContextV1, FileRefV1, NodeRefV1, ScreenListV1, type ContextNodeV1, type DesignContextV1 as DesignContext, type WarningV1, type FileRefV1 as FileRef, type NodeRefV1 as NodeRef } from '../contracts/v1.js';
import { RawDocumentEnvelopeV1 } from '../contracts/raw-document-v1.js';
import { AphroditeError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';
import { projectPaths, readProjectManifest, type ProjectPaths } from '../core/project.js';
import { readImportedDocument, type ImportedDocument } from '../import/import-document.js';
import { canonicalNodeId, normalizeGraph, type GraphNode, type GraphResult } from '../import/graph.js';
import { buildIndex } from '../index/build-index.js';
import type { DesignIndex, IndexRecord } from '../index/types.js';
import { parseFigmaFileRef, parseFigmaNodeRef } from './figma-url.js';
import { inferGuidance, warning } from './guidance.js';

type PublicRef = ReturnType<typeof parseFigmaFileRef>;
type PublicNodeRef = ReturnType<typeof parseFigmaNodeRef>;

export interface ContextBudget {
  depth?: number;
  maxNodes?: number;
  maxTextUnits?: number;
}

interface LoadedDocument {
  imported: ImportedDocument;
  graph: GraphResult;
  index: DesignIndex;
}

interface FactOptions {
  maxTextUnits: number;
  remainingTextUnits: number;
  textTruncated: boolean;
  warnings: WarningV1[];
}

const LAYOUT_FIELDS = ['layoutMode', 'layoutWrap', 'layoutAlign', 'layoutGrow', 'layoutSizingHorizontal', 'layoutSizingVertical', 'constraints', 'itemSpacing', 'counterAxisSpacing', 'counterAxisAlignItems', 'primaryAxisAlignItems', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'overflowDirection', 'strokesIncludedInLayout'];
const GEOMETRY_FIELDS = ['absoluteBoundingBox', 'absoluteRenderBounds', 'size', 'relativeTransform', 'absoluteTransform', 'x', 'y', 'width', 'height', 'rotation'];
const VISUAL_FIELDS = ['fills', 'strokes', 'strokeWeight', 'strokeAlign', 'individualStrokeWeights', 'effects', 'opacity', 'blendMode', 'cornerRadius', 'cornerRadii', 'rectangleCornerRadii', 'clipsContent', 'backgroundColor', 'backgrounds'];
const TEXT_STYLE_FIELDS = ['fontFamily', 'fontPostScriptName', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeightPx', 'lineHeightPercent', 'lineHeightUnit', 'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration', 'fills', 'strokes', 'strokeWeight', 'opacity'];
const OVERRIDE_FIELDS = new Set(['layoutMode', 'layoutAlign', 'layoutGrow', 'itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'constraints', 'characters', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeightPx', 'textAlignHorizontal', 'textAlignVertical', 'fills', 'strokes', 'strokeWeight', 'opacity', 'visible', 'componentPropertyReferences']);

function clonePublic(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth > 5) return undefined;
  if (Array.isArray(value)) return value.slice(0, 128).map(item => clonePublic(item, depth + 1)).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 128)) {
      const cloned = clonePublic(item, depth + 1);
      if (cloned !== undefined) result[key] = cloned;
    }
    return result;
  }
  return undefined;
}

function pick(raw: Record<string, any>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (raw[key] !== undefined) {
      const value = clonePublic(raw[key]);
      if (value !== undefined) result[key] = value;
    }
  }
  return result;
}

function canonicalMaybe(value: unknown): string | undefined {
  try { return canonicalNodeId(value); } catch { return undefined; }
}

function baseTextStyle(raw: Record<string, any>, textRaw: Record<string, any>): Record<string, unknown> {
  const merged = { ...pick(raw, TEXT_STYLE_FIELDS), ...pick(textRaw, TEXT_STYLE_FIELDS), ...pick(textRaw.style ?? {}, TEXT_STYLE_FIELDS) };
  return merged;
}

function styleOverride(table: unknown, styleId: unknown): Record<string, unknown> | undefined {
  if (styleId === undefined || styleId === null) return undefined;
  let value: unknown;
  if (Array.isArray(table)) value = table[Number(styleId)];
  else if (table && typeof table === 'object') value = (table as Record<string, unknown>)[String(styleId)];
  if (!value || typeof value !== 'object') return undefined;
  return pick(value as Record<string, any>, TEXT_STYLE_FIELDS);
}

function equalStyle(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function textFacts(raw: Record<string, any>, options: FactOptions): Record<string, unknown> | undefined {
  const textRaw = (raw.textData && typeof raw.textData === 'object' ? raw.textData : raw) as Record<string, any>;
  const characters = typeof textRaw.characters === 'string' ? textRaw.characters : typeof raw.characters === 'string' ? raw.characters : undefined;
  if (characters === undefined) return undefined;
  const fullUnits = characters.length;
  const allowedUnits = Math.min(options.maxTextUnits, options.remainingTextUnits);
  const text = characters.slice(0, allowedUnits);
  const textTruncated = text.length < fullUnits;
  options.remainingTextUnits -= text.length;
  if (textTruncated) options.textTruncated = true;
  const baseStyle = baseTextStyle(raw, textRaw);
  const ids = textRaw.characterStyleIDs ?? raw.characterStyleIDs;
  const table = textRaw.styleOverrideTable ?? raw.styleOverrideTable;
  const runs: Array<{ start: number; end: number; text: string; styleId?: number; resolvedStyle: Record<string, unknown> }> = [];
  let invalidStyles = false;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.length < Math.min(fullUnits, options.maxTextUnits)) invalidStyles = true;
    if (!invalidStyles) {
      let start = 0;
      for (let offset = 0; offset < text.length; offset++) {
        const rawStyleId = ids[offset];
        if (!(typeof rawStyleId === 'number' && Number.isInteger(rawStyleId) && rawStyleId >= 0) || (table !== undefined && !styleOverride(table, rawStyleId) && rawStyleId !== 0)) invalidStyles = true;
        const resolvedStyle = { ...baseStyle, ...(styleOverride(table, rawStyleId) ?? {}) };
        const styleId = typeof rawStyleId === 'number' && Number.isInteger(rawStyleId) ? rawStyleId : undefined;
        const previous = runs[runs.length - 1];
        if (previous && previous.styleId === styleId && equalStyle(previous.resolvedStyle, resolvedStyle)) {
          previous.end = offset + 1;
          previous.text = text.slice(previous.start, previous.end);
        } else {
          runs.push({ start, end: offset + 1, text: text.slice(start, offset + 1), ...(styleId === undefined ? {} : { styleId }), resolvedStyle });
          start = offset + 1;
        }
      }
    }
  }
  if (invalidStyles || runs.length === 0) {
    if (invalidStyles) options.warnings.push(warning('TEXT_STYLE_INVALID', 'Text style arrays or override IDs were inconsistent; a base-style run was used.'));
    runs.length = 0;
    if (text.length) runs.push({ start: 0, end: text.length, text, resolvedStyle: baseStyle });
  }
  const lines = clonePublic(textRaw.lines ?? raw.lines);
  return { characters: text, ...(lines !== undefined ? { lines } : {}), baseStyle, runs, ...(textTruncated ? { textTruncated: true } : {}) };
}

function componentFacts(raw: Record<string, any>, nodeId: string, index: DesignIndex, options: FactOptions): Record<string, unknown> | undefined {
  const type = String(raw.type ?? raw.nodeType ?? '');
  const symbolData = raw.symbolData && typeof raw.symbolData === 'object' ? raw.symbolData as Record<string, any> : undefined;
  const symbolID = canonicalMaybe(symbolData?.symbolID ?? raw.symbolID);
  if (type !== 'SYMBOL' && type !== 'INSTANCE' && !symbolData && !raw.componentPropertyReferences) return undefined;
  const result: Record<string, unknown> = { kind: type === 'SYMBOL' ? 'definition' : 'instance' };
  const definitionId = symbolID ?? (type === 'SYMBOL' ? nodeId : undefined);
  if (definitionId) {
    result.definitionId = definitionId;
    if (type === 'INSTANCE' && !index.byId[definitionId]) options.warnings.push(warning('COMPONENT_DEFINITION_MISSING', `Component definition ${definitionId} was not found.`, { definitionId }));
  }
  const sourceId = canonicalMaybe(symbolData?.sourceNodeID ?? symbolData?.sourceNodeId ?? raw.sourceNodeID);
  if (sourceId) result.sourceId = sourceId;
  const rawOverrides = symbolData?.symbolOverrides ?? raw.overrides;
  if (Array.isArray(rawOverrides)) {
    const overrides: Array<{ targetPath: string[]; properties: Record<string, unknown> }> = [];
    let unknownCount = 0;
    for (const override of rawOverrides) {
      if (!override || typeof override !== 'object') continue;
      const item = override as Record<string, any>;
      const rawPath = item.targetPath ?? item.path ?? item.target ?? item.id;
      const pathValues = Array.isArray(rawPath) ? rawPath : rawPath === undefined ? [] : [rawPath];
      const targetPath = pathValues.map(canonicalMaybe).filter((id): id is string => Boolean(id));
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(item)) {
        if (['targetPath', 'path', 'target', 'id'].includes(key)) continue;
        if (OVERRIDE_FIELDS.has(key)) {
          const cloned = clonePublic(value);
          if (cloned !== undefined) properties[key] = cloned;
        } else unknownCount++;
      }
      if (targetPath.length) overrides.push({ targetPath, properties });
      else if (Object.keys(properties).length) options.warnings.push(warning('COMPONENT_OVERRIDE_PATH_INVALID', 'A component override did not contain a canonical target path.'));
    }
    result.overrides = overrides;
    if (unknownCount) options.warnings.push(warning('COMPONENT_OVERRIDE_FIELDS_IGNORED', 'Unsupported component override fields were omitted.', undefined, unknownCount));
  }
  return result;
}

export function extractNodeFacts(node: GraphNode, index: DesignIndex, options: FactOptions): Record<string, unknown> {
  const raw = node.raw;
  const geometry = pick(raw, GEOMETRY_FIELDS);
  const layout = pick(raw, LAYOUT_FIELDS);
  const visual = pick(raw, VISUAL_FIELDS);
  const facts: Record<string, unknown> = {};
  if (Object.keys(geometry).length) facts.geometry = geometry;
  if (Object.keys(layout).length) facts.layout = layout;
  if (Object.keys(visual).length) facts.visual = visual;
  const text = textFacts(raw, options);
  if (text) facts.text = text;
  const component = componentFacts(raw, node.id, index, options);
  if (component) facts.component = component;
  return facts;
}

function toWarning(value: string): WarningV1 {
  return warning(value, value === 'DUPLICATE_SIBLING_POSITION' ? 'Sibling nodes share an equal recorded position.' : value);
}

function documentSummary(imported: ImportedDocument, includeSchemas = false) {
  const manifest = imported.manifest;
  return { importId: imported.importId, ...(manifest.fileKey ? { fileKey: manifest.fileKey } : {}), ...(manifest.alias ? { alias: manifest.alias } : {}), formatVersion: manifest.formatVersion, ...(includeSchemas ? { cacheSchemaVersion: manifest.cacheSchemaVersion, contextSchemaVersion: manifest.contextSchemaVersion } : {}) };
}

function cacheAssetsForNode(imported: ImportedDocument, nodeId: string): CacheAssetRecordV1[] {
  return imported.assets.records.filter(asset => asset.canonicalNodeId === nodeId);
}

function countSubtree(node: GraphNode): number {
  let count = 1;
  const stack = [...node.children];
  while (stack.length) { const current = stack.pop()!; count++; stack.push(...current.children); }
  return count;
}
function countContextSubtree(node: ContextNodeV1): number {
  let count = 1;
  const stack = [...node.children];
  while (stack.length) { const current = stack.pop()!; count++; stack.push(...current.children); }
  return count;
}

function limitContextAssets(root: ContextNodeV1, maximum: number): number {
  let remaining = maximum;
  let omitted = 0;
  const visit = (node: ContextNodeV1) => {
    if (node.assets.length > remaining) {
      omitted += node.assets.length - Math.max(0, remaining);
      node.assets = node.assets.slice(0, Math.max(0, remaining));
      remaining = 0;
    } else {
      remaining -= node.assets.length;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return omitted;
}

function childContexts(target: GraphNode, index: DesignIndex, imported: ImportedDocument, maxDepth: number, maxNodes: number, options: FactOptions): { node: ContextNodeV1; returned: number } {
  // Select nodes breadth-first first, then rebuild the original tree. This keeps
  // maxNodes deterministic and gives target facts/text priority over descendants.
  const selected = new Set<GraphNode>([target]);
  const queue: Array<{ node: GraphNode; depth: number }> = target.children.map(node => ({ node, depth: 1 }));
  while (queue.length && selected.size < maxNodes + 1) {
    const item = queue.shift()!;
    if (item.depth > maxDepth) continue;
    selected.add(item.node);
    if (item.depth < maxDepth) for (const child of item.node.children) queue.push({ node: child, depth: item.depth + 1 });
  }
  const build = (node: GraphNode): ContextNodeV1 => ({ id: node.id, name: String(node.raw.name ?? ''), type: String(node.raw.type ?? node.raw.nodeType ?? 'UNKNOWN'), facts: extractNodeFacts(node, index, options), assets: cacheAssetsForNode(imported, node.id), children: node.children.filter(child => selected.has(child)).map(build) });
  return { node: build(target), returned: selected.size };
}

async function readRawDocument(imported: ImportedDocument): Promise<RawDocumentEnvelopeV1> {
  try { return RawDocumentEnvelopeV1.parse(JSON.parse(await readFile(join(imported.documentDir, 'document.json'), 'utf8'))); }
  catch { throw new AphroditeError('CACHE_SCHEMA_UNSUPPORTED', 'The imported document cache is invalid; remove .aphrodite and re-import.'); }
}

export class DesignStore {
  readonly projectRoot: string;
  private readonly loaded = new Map<string, LoadedDocument>();

  constructor(projectRoot = process.cwd()) { this.projectRoot = projectRoot; }

  private async resolveFile(ref: FileRef): Promise<LoadedDocument> {
    FileRefV1.parse(ref);
    const parsed = parseFigmaFileRef(ref);
    const paths = projectPaths(this.projectRoot);
    const root = await readProjectManifest(paths);
    const key = parsed.alias ? `alias:${parsed.alias}` : parsed.fileKey ? `fileKey:${parsed.fileKey}` : undefined;
    let importId = key ? root.registrations[key]?.importId : undefined;
    if (!importId) {
      // Direct file-key references are useful when a caller has retained only a
      // manifest; scan immutable documents without mutating the registry.
      let entries: string[] = [];
      try { entries = await readdir(paths.documentsRoot); } catch { /* readProjectManifest already supplies the useful error */ }
      for (const entry of entries) {
        if (!/^[a-f0-9]{64}$/.test(entry)) continue;
        try {
          const manifest = DocumentManifestV1.parse(JSON.parse(await readFile(join(paths.documentsRoot, entry, 'manifest.json'), 'utf8')));
          if ((parsed.fileKey && manifest.fileKey === parsed.fileKey) || (parsed.alias && manifest.alias === parsed.alias)) { importId = manifest.importId; break; }
        } catch { /* invalid immutable entries are ignored until selected by registry */ }
      }
    }
    if (!importId) throw new AphroditeError('DOCUMENT_NOT_IMPORTED', `No imported document matches ${key ?? 'the supplied file reference'}.`);
    const cached = this.loaded.get(importId);
    if (cached) return cached;
    const imported = await readImportedDocument(this.projectRoot, importId);
    const envelope = await readRawDocument(imported);
    const graph = normalizeGraph(envelope.root as Record<string, any>);
    const loaded: LoadedDocument = { imported, graph, index: buildIndex(graph) };
    this.loaded.set(importId, loaded);
    return loaded;
  }

  async listScreens(ref: FileRef): Promise<ScreenListV1> {
    const parsed = FileRefV1.parse(ref);
    const loaded = await this.resolveFile(parsed);
    const pages = new Map<string, { id: string; name: string; screens: Array<{ id: string; name: string; type: string; size?: { width: number; height: number } }> }>();
    for (const record of loaded.index.records.filter(item => item.type === 'CANVAS')) pages.set(record.id, { id: record.id, name: record.name, screens: [] });
    const screenCap = Math.min(LIMITS.defaultScreens, LIMITS.maxScreens);
    for (const item of loaded.index.screens.slice(0, screenCap)) {
      const page = pages.get(item.pageId);
      if (!page) continue;
      page.screens.push({ id: item.node.id, name: item.node.name, type: item.node.type, ...(item.node.bounds ? { size: { width: item.node.bounds.width, height: item.node.bounds.height } } : {}) });
    }
    const allScreens = loaded.index.screens.length;
    const pagesValue = [...pages.values()].filter(page => page.screens.length || loaded.index.records.some(record => record.id === page.id));
    const result = ScreenListV1.parse({ schemaVersion: 1, document: documentSummary(loaded.imported), pages: pagesValue, truncation: { requested: { maxNodes: LIMITS.defaultScreens }, applied: { maxNodes: screenCap }, returnedNodes: Math.min(allScreens, screenCap), omittedNodes: Math.max(0, allScreens - screenCap), omittedAssets: 0, omittedGuidance: 0, textTruncated: false, truncated: allScreens > screenCap }, warnings: loaded.graph.warnings.map(toWarning) });
    return this.fitScreenSerializedBudget(result);
  }

  async getNodeContext(ref: NodeRef, budget: ContextBudget = {}): Promise<DesignContext> {
    const parsedInput = NodeRefV1.parse(ref);
    const parsed = parseFigmaNodeRef(parsedInput);
    const requested = ContextBudgetV1.parse(budget);
    const depth = requested.depth ?? LIMITS.defaultContextDepth;
    const maxNodes = requested.maxNodes ?? LIMITS.defaultContextNodes;
    const maxTextUnits = requested.maxTextUnits ?? LIMITS.defaultTextUnitsPerResponse;
    if (maxNodes < 1 || depth > LIMITS.maxContextDepth || maxNodes > LIMITS.maxContextNodes || maxTextUnits > LIMITS.maxTextUnitsPerResponse) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Context budget is outside the supported range.', { depth, maxNodes, maxTextUnits, minimumNodes: 1 });
    const loaded = await this.resolveFile(parsed.alias ? { alias: parsed.alias } : { fileKey: parsed.fileKey! });
    const target = loaded.graph.nodes.get(parsed.nodeId);
    if (!target) throw new AphroditeError('NODE_NOT_FOUND', `Node ${parsed.nodeId} was not found in the imported document.`, { nodeId: parsed.nodeId });
    const targetRecord = loaded.index.byId[parsed.nodeId];
    const warnings: WarningV1[] = loaded.graph.warnings.map(toWarning);
    const options: FactOptions = { maxTextUnits: Math.min(LIMITS.maxTextUnitsPerNode, maxTextUnits), remainingTextUnits: maxTextUnits, textTruncated: false, warnings };
    const ancestry: string[] = [];
    let parent = target.parentId;
    while (parent && ancestry.length < LIMITS.maxAncestry) { ancestry.push(parent); parent = loaded.graph.nodes.get(parent)?.parentId ?? null; }
    ancestry.reverse();
    const built = childContexts(target, loaded.index, loaded.imported, depth, Math.max(0, maxNodes - 1), options);
    const omittedAssets = limitContextAssets(built.node, LIMITS.maxAssets);
    const totalNodes = countSubtree(target);
    const returnedNodes = Math.min(totalNodes, built.returned);
    const omittedNodes = Math.max(0, totalNodes - returnedNodes);
    const targetFacts = built.node.facts;
    const guidance = inferGuidance(target.raw, targetFacts, target.children.length).slice(0, LIMITS.maxGuidance);
    const resultBase: DesignContext = DesignContextV1.parse({ schemaVersion: 1, document: documentSummary(loaded.imported, true), target: { id: target.id, name: String(target.raw.name ?? ''), type: String(target.raw.type ?? target.raw.nodeType ?? 'UNKNOWN'), ...(targetRecord?.pageId ? { pageId: targetRecord.pageId } : {}), ancestry }, facts: targetFacts, assets: built.node.assets, children: built.node.children, guidance, truncation: { requested, applied: { depth, maxNodes, maxTextUnits }, returnedNodes, omittedNodes, omittedAssets, omittedGuidance: Math.max(0, inferGuidance(target.raw, targetFacts, target.children.length).length - LIMITS.maxGuidance), textTruncated: options.textTruncated, truncated: omittedNodes > 0 || options.textTruncated || omittedAssets > 0 }, warnings });
    return this.fitSerializedBudget(resultBase);
  }

  private fitScreenSerializedBudget(result: ScreenListV1): ScreenListV1 {
    let current = JSON.parse(JSON.stringify(result)) as ScreenListV1;
    const size = () => Buffer.byteLength(JSON.stringify(current), 'utf8');
    if (size() <= LIMITS.maxSerializedResponseBytes) return current;
    while (size() > LIMITS.maxSerializedResponseBytes) {
      const page = [...current.pages].reverse().find(item => item.screens.length > 0);
      if (!page) break;
      page.screens.pop();
      current.truncation.returnedNodes = Math.max(0, current.truncation.returnedNodes - 1);
      current.truncation.omittedNodes += 1;
      current.truncation.truncated = true;
    }
    while (size() > LIMITS.maxSerializedResponseBytes && current.pages.length) {
      const removed = current.pages.pop()!;
      current.truncation.returnedNodes = Math.max(0, current.truncation.returnedNodes - removed.screens.length);
      current.truncation.omittedNodes += removed.screens.length;
      current.truncation.truncated = true;
    }
    if (size() > LIMITS.maxSerializedResponseBytes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Serialized screen list exceeds the hard response limit.');
    return ScreenListV1.parse(current);
  }

  private fitSerializedBudget(result: DesignContext): DesignContext {
    let current = result;
    const size = () => Buffer.byteLength(JSON.stringify(current), 'utf8');
    if (size() <= LIMITS.maxSerializedResponseBytes) return current;
    const clone = (value: DesignContext): DesignContext => JSON.parse(JSON.stringify(value)) as DesignContext;
    current = clone(current);
    while (size() > LIMITS.maxSerializedResponseBytes && current.children.length) {
      const removed = current.children.pop()!;
      const removedNodes = countContextSubtree(removed);
      current.truncation.returnedNodes = Math.max(0, current.truncation.returnedNodes - removedNodes);
      current.truncation.omittedNodes += removedNodes;
      current.truncation.truncated = true;
    }
    while (size() > LIMITS.maxSerializedResponseBytes && current.assets.length) { current.assets.pop(); current.truncation.omittedAssets++; current.truncation.truncated = true; }
    while (size() > LIMITS.maxSerializedResponseBytes && current.guidance.length) { current.guidance.pop(); current.truncation.omittedGuidance++; current.truncation.truncated = true; }
    if (size() > LIMITS.maxSerializedResponseBytes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Serialized design context exceeds the hard response limit.');
    return DesignContextV1.parse(current);
  }
}

export function createDesignStore(projectRoot = process.cwd()): DesignStore { return new DesignStore(projectRoot); }
