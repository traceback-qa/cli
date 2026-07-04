import { EXIT_AUTH_ERROR, EXIT_PERMISSION_DENIED } from '../constants/exit-codes.js';
import { TracebackError } from './base.error.js';

export class AuthError extends TracebackError {
  readonly isUserFault = true;
  readonly code = 'AUTH_ERROR';
  readonly statusCode = EXIT_AUTH_ERROR;

  constructor(message: string, opts?: { help?: string }) {
    super(message, opts);
  }
}

export class NotAuthenticatedError extends TracebackError {
  readonly isUserFault = true;
  readonly code = 'AUTH_NOT_AUTHENTICATED';
  readonly statusCode = EXIT_AUTH_ERROR;

  constructor() {
    super('You are not authenticated.', {
      help: 'Run `traceback auth login` to authenticate.',
    });
  }
}

export class TokenExpiredError extends TracebackError {
  readonly isUserFault = true;
  override retryable = true;
  readonly code = 'AUTH_TOKEN_EXPIRED';
  readonly statusCode = EXIT_AUTH_ERROR;

  constructor() {
    super('Authentication token has expired and could not be refreshed.', {
      help: 'Run `traceback auth login` to re-authenticate.',
    });
  }
}

export class ForbiddenError extends TracebackError {
  readonly isUserFault = true;
  readonly code = 'AUTH_FORBIDDEN';
  readonly statusCode = EXIT_PERMISSION_DENIED;

  readonly resource?: string;

  constructor(resource?: string) {
    const resourceMsg = resource ? ` to ${resource}` : '';
    super(`You do not have permission to access${resourceMsg}.`);
    this.resource = resource;
  }
}
