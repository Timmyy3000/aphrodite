import type { GuidanceV1, WarningV1 } from '../contracts/v1.js';

export function warning(code: string, message: string, details?: Record<string, unknown>, count?: number): WarningV1 {
  return { code, message, ...(count === undefined ? {} : { count }), ...(details ? { details } : {}) };
}

/**
 * Small deterministic heuristics. These intentionally cite recorded fact paths
 * and never rewrite the facts themselves into inferred CSS decisions.
 */
export function inferGuidance(raw: Record<string, any>, facts: Record<string, unknown>, childCount: number): GuidanceV1[] {
  const guidance: GuidanceV1[] = [];
  const layoutMode = raw.layoutMode ?? raw.layout?.layoutMode;
  if ((layoutMode === 'HORIZONTAL' || layoutMode === 'VERTICAL') && childCount > 0) {
    guidance.push({
      kind: 'layout',
      suggestion: `Use a semantic flex ${layoutMode === 'HORIZONTAL' ? 'row' : 'column'} container; use the recorded spacing and padding as verification evidence.`,
      confidence: 0.9,
      evidence: ['facts.layout.layoutMode', ...(raw.itemSpacing !== undefined ? ['facts.layout.itemSpacing'] : [])],
    });
  } else if (layoutMode === 'NONE' && childCount > 1 && raw.constraints) {
    guidance.push({
      kind: 'layout',
      suggestion: 'Prefer the project’s semantic layout convention and use the recorded constraints/bounds to verify alignment; avoid blanket absolute positioning.',
      confidence: 0.55,
      evidence: ['facts.layout.constraints', 'facts.geometry.absoluteBoundingBox'],
    });
  }
  if (raw.layoutWrap === 'WRAP' || raw.layout?.layoutWrap === 'WRAP') {
    guidance.push({ kind: 'grid', suggestion: 'A wrapping layout may map cleanly to CSS grid or flex-wrap; verify columns against the recorded bounds.', confidence: 0.65, evidence: ['facts.layout.layoutWrap'] });
  }
  if (facts.text && childCount === 0) {
    guidance.push({ kind: 'text', suggestion: 'Preserve the recorded typography and text runs, then validate line wrapping in the consuming application.', confidence: 0.8, evidence: ['facts.text.baseStyle', 'facts.text.runs'] });
  }
  return guidance;
}
