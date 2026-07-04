import { EXIT_NETWORK_ERROR } from '../constants/exit-codes.js';
import { TracebackError } from './base.error.js';

export class NetworkError extends TracebackError {
  readonly isUserFault = false;
  override retryable = true;
  readonly code = 'NETWORK_ERROR';
  readonly statusCode = EXIT_NETWORK_ERROR;

  constructor(message: string, opts?: { help?: string }) {
    super(message, opts);
  }
}

export class TimeoutError extends TracebackError {
  readonly isUserFault = false;
  override retryable = true;
  readonly code = 'NETWORK_TIMEOUT';
  readonly statusCode = EXIT_NETWORK_ERROR;

  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`, {
      help: 'The server took too long to respond. Check your connection and try again.',
    });
    this.timeoutMs = timeoutMs;
  }
}

export class ConnectionError extends TracebackError {
  readonly isUserFault = false;
  override retryable = true;
  readonly code = 'NETWORK_CONNECTION';
  readonly statusCode = EXIT_NETWORK_ERROR;

  constructor(details?: string) {
    super(`Could not connect to the server.${details ? ` ${details}` : ''}`, {
      help: 'Check your internet connection and ensure the API is reachable.',
    });
  }
}

export class DnsError extends TracebackError {
  readonly isUserFault = false;
  readonly code = 'NETWORK_DNS';
  readonly statusCode = EXIT_NETWORK_ERROR;

  readonly hostname: string;

  constructor(hostname: string) {
    super(`Could not resolve hostname: ${hostname}`, {
      help: 'Check your DNS configuration and internet connection.',
    });
    this.hostname = hostname;
  }
}
