export type ErrorCode =
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'mfa_required'
  | 'not_found'
  | 'conflict'
  | 'internal'

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  mfa_required: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
}

export class AppError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AppError'
    this.code = code
  }
  get status(): number {
    return STATUS[this.code]
  }
}
