import { z } from 'zod';
import { ERROR_CODES } from './error-codes.js';
const CanonicalId = z.string().regex(/^\d+:\d+$/);
export const WarningV1 = z.object({ code: z.string(), message: z.string(), count: z.number().int().nonnegative().optional(), details: z.record(z.string(), z.unknown()).optional() }).strict();
export type WarningV1 = z.infer<typeof WarningV1>;
export const FileRefV1 = z.union([z.object({ url: z.string().url() }).strict(), z.object({ fileKey: z.string().regex(/^[A-Za-z0-9]+$/) }).strict(), z.object({ alias: z.string().min(1) }).strict()]);
export type FileRefV1 = z.infer<typeof FileRefV1>;
export const NodeRefV1 = z.union([z.object({ url: z.string().url() }).strict(), z.object({ fileKey: z.string().regex(/^[A-Za-z0-9]+$/), nodeId: z.string().min(1) }).strict(), z.object({ alias: z.string().min(1), nodeId: z.string().min(1) }).strict()]);
export type NodeRefV1 = z.infer<typeof NodeRefV1>;
export const TruncationV1 = z.object({ requested: z.object({ depth: z.number().int().nonnegative().optional(), maxNodes: z.number().int().nonnegative().optional(), maxTextUnits: z.number().int().nonnegative().optional() }).strict().optional(), applied: z.object({ depth: z.number().int().nonnegative().optional(), maxNodes: z.number().int().nonnegative().optional(), maxTextUnits: z.number().int().nonnegative().optional() }).strict().optional(), returnedNodes: z.number().int().nonnegative(), omittedNodes: z.number().int().nonnegative(), omittedAssets: z.number().int().nonnegative(), omittedGuidance: z.number().int().nonnegative(), textTruncated: z.boolean(), truncated: z.boolean() }).strict();
export type TruncationV1 = z.infer<typeof TruncationV1>;
const CacheAssetPath = z.string().regex(/^assets\/(?:raster|vector)\/(?!\.{1,2}$)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, 'cacheSourcePath must be a normalized document-relative asset path');
export const AssetV1 = z.object({ canonicalNodeId: CanonicalId, rawReference: z.union([z.string(), z.number().int().nonnegative()]), kind: z.enum(['raster', 'svg']), status: z.enum(['resolved', 'missing', 'invalid', 'unsupported']), cacheSourcePath: CacheAssetPath.optional(), mimeType: z.string().optional(), dimensions: z.object({ width: z.number().nonnegative(), height: z.number().nonnegative() }).strict().optional(), reasonCode: z.string().optional(), mustCopyToTrackedProject: z.literal(true) }).strict();
export type AssetV1 = z.infer<typeof AssetV1>;
export const ScreenV1 = z.object({ id: CanonicalId, name: z.string(), type: z.string(), size: z.object({ width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict().optional() }).strict();
export const PageScreensV1 = z.object({ id: CanonicalId, name: z.string(), screens: z.array(ScreenV1) }).strict();
export const ScreenListV1 = z.object({ schemaVersion: z.literal(1), document: z.object({ importId: z.string(), fileKey: z.string().optional(), alias: z.string().optional(), formatVersion: z.literal(106) }).strict(), pages: z.array(PageScreensV1), truncation: TruncationV1, warnings: z.array(WarningV1) }).strict();
export type ScreenListV1 = z.infer<typeof ScreenListV1>;
export const ContextNodeV1: z.ZodType<any> = z.object({ id: CanonicalId, name: z.string(), type: z.string(), facts: z.record(z.string(), z.unknown()), assets: z.array(AssetV1), children: z.lazy(() => z.array(ContextNodeV1)) }).strict();
export type ContextNodeV1 = z.infer<typeof ContextNodeV1>;
export const GuidanceV1 = z.object({ kind: z.string(), suggestion: z.string(), confidence: z.number().min(0).max(1), evidence: z.array(z.string()) }).strict();
export type GuidanceV1 = z.infer<typeof GuidanceV1>;
export const DesignContextV1 = z.object({ schemaVersion: z.literal(1), document: z.object({ importId: z.string(), fileKey: z.string().optional(), alias: z.string().optional(), formatVersion: z.literal(106), cacheSchemaVersion: z.literal(1), contextSchemaVersion: z.literal(1) }).strict(), target: z.object({ id: CanonicalId, name: z.string(), type: z.string(), pageId: CanonicalId.optional(), ancestry: z.array(CanonicalId) }).strict(), facts: z.record(z.string(), z.unknown()), assets: z.array(AssetV1), children: z.array(ContextNodeV1), guidance: z.array(GuidanceV1), truncation: TruncationV1, warnings: z.array(WarningV1) }).strict();
export type DesignContextV1 = z.infer<typeof DesignContextV1>;
export const ErrorEnvelopeV1 = z.object({ schemaVersion: z.literal(1), error: z.object({ code: z.enum(ERROR_CODES), message: z.string(), details: z.record(z.string(), z.unknown()).optional(), retryable: z.boolean() }).strict() }).strict();
export type ErrorEnvelopeV1 = z.infer<typeof ErrorEnvelopeV1>;
export const PublicSchemaVersion = z.literal(1);

/** Shared bounded context options. Values above the hard limits are rejected by DesignStore. */
export const ContextBudgetV1 = z.object({ depth: z.number().int().nonnegative().optional(), maxNodes: z.number().int().nonnegative().optional(), maxTextUnits: z.number().int().nonnegative().optional() }).strict();
export type ContextBudgetV1 = z.infer<typeof ContextBudgetV1>;

/** Transport input accepted by the list-screens MCP tool. */
export const ListScreensInputV1 = FileRefV1;
export type ListScreensInputV1 = z.infer<typeof ListScreensInputV1>;

/** Transport input accepted by get-design-context. Both wrapped and direct forms are accepted for clients. */
export const GetDesignContextInputV1 = z.union([
  z.object({ ref: NodeRefV1, depth: z.number().int().nonnegative().optional(), maxNodes: z.number().int().nonnegative().optional(), maxTextUnits: z.number().int().nonnegative().optional() }).strict(),
  z.object({ url: z.string().url(), depth: z.number().int().nonnegative().optional(), maxNodes: z.number().int().nonnegative().optional(), maxTextUnits: z.number().int().nonnegative().optional() }).strict(),
  z.object({ fileKey: z.string().regex(/^[A-Za-z0-9]+$/), nodeId: z.string().min(1), depth: z.number().int().nonnegative().optional(), maxNodes: z.number().int().nonnegative().optional(), maxTextUnits: z.number().int().nonnegative().optional() }).strict(),
  z.object({ alias: z.string().min(1), nodeId: z.string().min(1), depth: z.number().int().nonnegative().optional(), maxNodes: z.number().int().nonnegative().optional(), maxTextUnits: z.number().int().nonnegative().optional() }).strict(),
]);
export type GetDesignContextInputV1 = z.infer<typeof GetDesignContextInputV1>;
