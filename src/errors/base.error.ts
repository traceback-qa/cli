import { EXIT_UNEXPECTED } from '../constants/exit-codes.js';

export abstract class TracebackError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  abstract readonly isUserFault: boolean;

  retryable = false;
  readonly help?: string;
  readonly docsUrl?: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, opts?: { help?: string; docsUrl?: string; context?: Record<string, unknown> }) {
    super(message);
    this.name = this.constructor.name;
    this.help = opts?.help;
    this.docsUrl = opts?.docsUrl;
    this.context = opts?.context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnexpectedError extends TracebackError {
  readonly code = 'UNEXPECTED';
  readonly statusCode = EXIT_UNEXPECTED;
  readonly isUserFault = false;

  readonly originalError?: Error;

  constructor(message: string, opts?: { originalError?: Error }) {
    super(message);
    this.originalError = opts?.originalError;
  }
}
