import { EXIT_USER_ERROR, EXIT_NO_CONFIG } from '../constants/exit-codes.js';
import { TracebackError } from './base.error.js';

export class UserError extends TracebackError {
  readonly isUserFault = true;
  readonly code = 'USER_ERROR';
  readonly statusCode = EXIT_USER_ERROR;

  constructor(message: string, opts?: { help?: string; docsUrl?: string }) {
    super(message, opts);
  }
}

export class ValidationError extends TracebackError {
  readonly isUserFault = true;
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = EXIT_USER_ERROR;

  readonly errors: Array<{ path: string; message: string }>;

  constructor(errors: Array<{ path: string; message: string }>, opts?: { help?: string }) {
    const message =
      errors.length === 1
        ? `Validation error: ${errors[0]?.message}`
        : `Validation failed with ${errors.length} errors:\n${errors.map((e) => `  • ${e.path}: ${e.message}`).join('\n')}`;
    super(message, opts);
    this.errors = errors;
  }
}

export class ConfigurationError extends TracebackError {
  readonly isUserFault = true;
  readonly code = 'CONFIG_ERROR';
  readonly statusCode = EXIT_NO_CONFIG;

  readonly configPath?: string;

  constructor(message: string, opts?: { configPath?: string; help?: string }) {
    super(message, opts);
    this.configPath = opts?.configPath;
  }
}

export class FileNotFoundError extends TracebackError {
  readonly isUserFault = true;
  readonly code = 'FILE_NOT_FOUND';
  readonly statusCode = EXIT_USER_ERROR;

  readonly filePath: string;

  constructor(filePath: string) {
    super(`File not found: ${filePath}`, { help: 'Check the file path and try again.' });
    this.filePath = filePath;
  }
}

export class CommandCancelledError extends TracebackError {
  readonly isUserFault = true;
  readonly code = 'COMMAND_CANCELLED';
  readonly statusCode = 130;

  constructor() {
    super('Command was cancelled.');
  }
}
