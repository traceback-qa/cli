export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Logger {
  silent: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  debug: (msg: string, ...args: unknown[]) => void;
  trace: (msg: string, ...args: unknown[]) => void;
  setLevel: (level: LogLevel) => void;
  getLevel: () => LogLevel;
  child: (bindings: Record<string, unknown>) => Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  filePath?: string;
  pretty?: boolean;
}
