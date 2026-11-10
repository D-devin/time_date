export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'STORAGE_WRITE_FAILED'
  | 'DATA_CORRUPTED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'STORE_IN_USE'
  | 'STORE_CLOSED';

export class PlannerError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PlannerError';
  }
}
