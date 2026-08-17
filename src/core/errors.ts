import type { ErrorCode } from '../contracts/error-codes.js';
import { ErrorEnvelopeV1 } from '../contracts/v1.js';
export class AphroditeError extends Error {
  readonly code: ErrorCode; readonly details?: Record<string, unknown>; readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, retryable = false) { super(message); this.name = 'AphroditeError'; this.code = code; this.details = details; this.retryable = retryable; }
  envelope() { return ErrorEnvelopeV1.parse({ schemaVersion: 1, error: { code: this.code, message: this.message, details: this.details, retryable: this.retryable } }); }
}
export function asAphroditeError(error: unknown, fallback = 'Unexpected Aphrodite error'): AphroditeError { if (error instanceof AphroditeError) return error; return new AphroditeError('DOCUMENT_INVALID', error instanceof Error ? error.message : fallback); }
