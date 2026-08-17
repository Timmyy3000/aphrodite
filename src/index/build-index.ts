import type { GraphResult } from '../import/graph.js';
import { graphNodeRecord, type DesignIndex, type IndexRecord } from './types.js';
export function buildIndex(graph: GraphResult): DesignIndex {
  const records: IndexRecord[] = []; const byId: Record<string, IndexRecord> = {}; const screens: DesignIndex['screens'] = [];
  const queue: Array<{ node: typeof graph.root; parent?: IndexRecord; depth: number; pageId: string | null; pageName: string }> = [{ node: graph.root, depth: 0, pageId: null, pageName: '' }];
  while (queue.length) { const item = queue.shift()!; const { node, parent, depth, pageName } = item; const record = graphNodeRecord(node, parent, depth); const pageId = item.pageId ?? (record.type === 'CANVAS' ? record.id : null); if (pageId) record.pageId = pageId; records.push(record); byId[record.id] = record; const nextPageName = record.type === 'CANVAS' ? record.name : pageName; if (parent?.type === 'CANVAS' && parent.visible && (record.type === 'FRAME' || record.type === 'SECTION') && record.visible) screens.push({ pageId: parent.id, pageName: nextPageName, node: record }); for (const child of node.children) queue.push({ node: child, parent: record, depth: depth + 1, pageId: record.pageId, pageName: nextPageName }); }
  return { schemaVersion: 1, records, byId, screens };
}
