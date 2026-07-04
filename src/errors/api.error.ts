import { EXIT_API_ERROR } from '../constants/exit-codes.js';
import { TracebackError } from './base.error.js';

export class ApiError extends TracebackError {
  readonly isUserFault = false;
  readonly code = 'API_ERROR';
  readonly statusCode = EXIT_API_ERROR;

  readonly httpStatus: number;

  constructor(
    message: string,
    httpStatus: number,
    opts?: { help?: string; retryable?: boolean },
  ) {
    super(message, opts);
    this.httpStatus = httpStatus;
    this.retryable = opts?.retryable ?? false;
  }
}

export class RateLimitedError extends TracebackError {
  readonly isUserFault = false;
  override retryable = true;
  readonly code = 'API_RATE_LIMITED';
  readonly statusCode = EXIT_API_ERROR;
  readonly httpStatus = 429;

  readonly retryAfterSeconds?: number;

  constructor(retryAfterSeconds?: number) {
    const help = retryAfterSeconds
      ? `Rate limited. Try again in ${retryAfterSeconds} seconds.`
      : 'Rate limited. Try again shortly.';
    super(help);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NotFoundError extends TracebackError {
  readonly isUserFault = false;
  readonly code = 'API_NOT_FOUND';
  readonly statusCode = EXIT_API_ERROR;
  readonly httpStatus = 404;

  readonly resource: string;

  constructor(resource: string) {
    super(`Resource not found: ${resource}`);
    this.resource = resource;
  }
}

export class ConflictError extends TracebackError {
  readonly isUserFault = false;
  readonly code = 'API_CONFLICT';
  readonly statusCode = EXIT_API_ERROR;
  readonly httpStatus = 409;

  constructor(message: string) {
    super(message);
  }
}

export class ServerError extends TracebackError {
  readonly isUserFault = false;
  override retryable = true;
  readonly code = 'API_SERVER_ERROR';
  readonly statusCode = EXIT_API_ERROR;

  readonly httpStatus: number;

  constructor(httpStatus: number) {
    super(`Server error (${httpStatus}). Please try again.`);
    this.httpStatus = httpStatus;
  }
}
