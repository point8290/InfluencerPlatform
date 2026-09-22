/**
 * Error codes are part of the API contract — clients branch on `code`, never on
 * `message`. The full table lives in docs/API.md; this union is its executable
 * counterpart, so adding a code here without documenting it is a visible edit.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PLAN_CURRENCY_MISMATCH'
  | 'CURRENCY_MODULE_MISMATCH'
  | 'INVALID_SIGNATURE'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'NOT_FOUND'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'CAMPAIGN_ALREADY_FUNDED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENT_REQUEST_IN_PROGRESS'
  | 'CHECKOUT_NOT_RESUMABLE'
  | 'INSUFFICIENT_CREDITS'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  field: string;
  message: string;
}

/**
 * Every error the API raises deliberately is an AppError. Anything else
 * reaching the error handler is a bug, and is reported as INTERNAL_ERROR with
 * its details logged rather than returned.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[];

  constructor(code: ErrorCode, status: number, message: string, details: ErrorDetail[] = []) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: ErrorDetail[] = []) {
    super('VALIDATION_ERROR', 400, message, details);
  }
}

/**
 * A 400 that is not a shape problem — the body parsed fine, but what it asked
 * for is incoherent (a plan from a different currency, a currency the campaign's
 * module is not bound to). These carry their own codes so a client can tell
 * "malformed" from "contradictory".
 */
export class BadRequestError extends AppError {
  constructor(code: ErrorCode, message: string) {
    super(code, 400, message);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication is required.') {
    super('UNAUTHENTICATED', 401, message);
  }
}

/**
 * Login failure. The message is deliberately identical whether the email is
 * unknown or the password is wrong — the endpoint must not become an oracle
 * for which accounts exist.
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Email or password is incorrect.');
  }
}

/**
 * Used for resources that are absent *and* for resources owned by another
 * user — ownership is not an information leak, so both look identical.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.') {
    super('NOT_FOUND', 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(code: ErrorCode, message: string) {
    super(code, 409, message);
  }
}

export class UnprocessableError extends AppError {
  constructor(code: ErrorCode, message: string) {
    super(code, 422, message);
  }
}
