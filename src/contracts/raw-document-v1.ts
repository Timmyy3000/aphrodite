import { z } from 'zod';
export const RawDocumentEnvelopeV1 = z.object({ rawSchemaVersion: z.literal(1), figVersion: z.literal(106), root: z.unknown(), blobs: z.unknown() }).strict();
export type RawDocumentEnvelopeV1 = z.infer<typeof RawDocumentEnvelopeV1>;
