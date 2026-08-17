import { AphroditeError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';

export interface GraphNode { id: string; raw: Record<string, any>; parentId: string | null; children: GraphNode[]; position?: number | string; }
export interface GraphResult { root: GraphNode; nodes: Map<string, GraphNode>; warnings: string[]; }
export function canonicalNodeId(value: unknown): string {
  if (typeof value === 'string') { const match = /^(\d+)[-:](\d+)$/.exec(value); if (!match) throw new AphroditeError('DOCUMENT_INVALID', `Invalid node ID ${value}.`); const session = BigInt(match[1]); const local = BigInt(match[2]); if (session > 0xffffffffn || local > 0xffffffffn) throw new AphroditeError('DOCUMENT_INVALID', 'Node ID exceeds unsigned 32-bit range.'); return `${session}:${local}`; }
  const guid = (value as any)?.guid ?? value; const session = Number(guid?.sessionID); const local = Number(guid?.localID); if (!Number.isInteger(session) || !Number.isInteger(local) || session < 0 || local < 0 || session > 0xffffffff || local > 0xffffffff) throw new AphroditeError('DOCUMENT_INVALID', 'Invalid node GUID.'); return `${session}:${local}`;
}
function positionOf(node: any) {
  const value = node?.parentIndex?.position ?? node?.position;
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 256) return value;
  throw new AphroditeError('DOCUMENT_INVALID', 'Node sibling position is not a supported bounded scalar.');
}
function compareCodeUnits(a: string, b: string) { if (a === b) return 0; const length = Math.min(a.length, b.length); for (let index = 0; index < length; index++) { const difference = a.charCodeAt(index) - b.charCodeAt(index); if (difference) return difference; } return a.length - b.length; }
function comparePosition(a: GraphNode, b: GraphNode) { const av = a.position; const bv = b.position; const at = typeof av === 'number' ? 0 : typeof av === 'string' ? 1 : 2; const bt = typeof bv === 'number' ? 0 : typeof bv === 'string' ? 1 : 2; if (at !== bt) return at - bt; if (at === 0 && (av as number) !== (bv as number)) return (av as number) < (bv as number) ? -1 : 1; if (at === 1) { const position = compareCodeUnits(av as string, bv as string); if (position) return position; } return compareCodeUnits(a.id, b.id); }
export function normalizeGraph(rootValue: Record<string, any>, signal?: AbortSignal): GraphResult {
  const nodes = new Map<string, GraphNode>(); const warnings: string[] = []; let visited = 0;
  const rootId = canonicalNodeId(rootValue); if (rootId !== '0:0') throw new AphroditeError('DOCUMENT_INVALID', 'Document root must have canonical ID 0:0.');
  const stack: Array<{ raw: any; parentId: string | null; }> = [{ raw: rootValue, parentId: null }];
  while (stack.length) {
    if (signal?.aborted) throw new AphroditeError('IMPORT_CANCELLED', 'Import was cancelled.');
    const item = stack.pop()!; const raw = item.raw as Record<string, any>; const id = canonicalNodeId(raw); if (nodes.has(id)) throw new AphroditeError('DUPLICATE_NODE_ID', `Duplicate node ID ${id}.`, { id });
    if (raw.parentIndex !== undefined && !raw.parentIndex?.guid) throw new AphroditeError('INVALID_PARENT', `Node ${id} contains invalid parent evidence.`, { id });
    const parentFromRaw = raw.parentIndex?.guid ? canonicalNodeId(raw.parentIndex.guid) : item.parentId; const graph: GraphNode = { id, raw, parentId: parentFromRaw, children: [], position: positionOf(raw) }; nodes.set(id, graph); visited++; if (visited > LIMITS.maxNodes) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Node count exceeded its limit.', { observed: visited, limit: LIMITS.maxNodes });
    const children = Array.isArray(raw.children) ? raw.children : []; const childGraphs: Array<{ raw: any; parentId: string | null; }> = []; for (let i = children.length - 1; i >= 0; i--) childGraphs.push({ raw: children[i], parentId: id }); stack.push(...childGraphs);
  }
  const root = nodes.get('0:0')!;
  for (const node of nodes.values()) {
    if (node.id === '0:0') { if (node.parentId !== null) throw new AphroditeError('INVALID_PARENT', 'Root node cannot have a parent.'); continue; }
    if (!node.parentId || node.parentId === node.id || !nodes.has(node.parentId)) throw new AphroditeError('INVALID_PARENT', `Node ${node.id} has an invalid parent.`, { id: node.id, parentId: node.parentId });
    nodes.get(node.parentId)!.children.push(node);
  }
  for (const parent of nodes.values()) {
    const positions = new Map<string, number>(); for (const child of parent.children) { const key = `${typeof child.position}:${String(child.position)}`; positions.set(key, (positions.get(key) ?? 0) + 1); }
    if ([...positions.values()].some(count => count > 1)) warnings.push('DUPLICATE_SIBLING_POSITION');
    parent.children.sort(comparePosition);
  }
  const colors = new Map<string, 0 | 1 | 2>(); const dfs: Array<{ node: GraphNode; entering: boolean; depth: number }> = [{ node: root, entering: true, depth: 0 }];
  while (dfs.length) { const current = dfs.pop()!; if (current.entering) { if (current.depth > LIMITS.maxParentDepth) throw new AphroditeError('RESOURCE_LIMIT_EXCEEDED', 'Parent depth exceeded its limit.'); const color = colors.get(current.node.id) ?? 0; if (color === 1) throw new AphroditeError('GRAPH_CYCLE', `Graph cycle includes ${current.node.id}.`); if (color === 2) continue; colors.set(current.node.id, 1); dfs.push({ node: current.node, entering: false, depth: current.depth }); for (let i = current.node.children.length - 1; i >= 0; i--) dfs.push({ node: current.node.children[i], entering: true, depth: current.depth + 1 }); } else colors.set(current.node.id, 2); }
  if (colors.size !== nodes.size) throw new AphroditeError('UNREACHABLE_NODE', 'Document contains nodes unreachable from root.', { reachable: colors.size, total: nodes.size });
  return { root, nodes, warnings };
}
