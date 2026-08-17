import { describe, expect, it } from 'vitest';
import { normalizeGraph } from '../../src/import/graph.js';
import { AphroditeError } from '../../src/core/errors.js';
const root = (children: any[]) => ({ guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children });
const child = (id: number, parentIndex?: any, children: any[] = []) => ({ guid: { sessionID: 1, localID: id }, type: 'FRAME', name: String(id), ...(parentIndex ? { parentIndex } : {}), children });
describe('graph validation', () => {
  it('normalizes canonical IDs and deterministic children', () => { const graph = normalizeGraph(root([child(2), child(1)])); expect(graph.root.children.map(n => n.id)).toEqual(['1:1', '1:2']); expect(graph.nodes.size).toBe(3); });
  it('rejects duplicate IDs', () => expect(() => normalizeGraph(root([child(1), child(1)]))).toThrowError(AphroditeError));
  it('rejects invalid parents', () => expect(() => normalizeGraph(root([child(1, { guid: { sessionID: 9, localID: 9 } })]))).toThrowError(AphroditeError));
  it('rejects orphaned and cyclic parent evidence deterministically', () => {
    expect(() => normalizeGraph(root([child(1, { guid: { sessionID: 9, localID: 9 } })]))).toThrowError(/invalid parent/i);
    const a = child(1, { guid: { sessionID: 0, localID: 0 } });
    const b = child(2, { guid: { sessionID: 1, localID: 1 } });
    a.children = [b]; b.children = [a];
    expect(() => normalizeGraph(root([a]))).toThrowError(AphroditeError);
  });
});
