import pino from 'pino';
import type { Logger, LoggerOptions, LogLevel } from './logger.types.js';

function levelToPino(level: LogLevel): pino.LevelWithSilent {
  if (level === 'silent') return 'silent';
  return level;
}

export function createLogger(opts: LoggerOptions): Logger {
  const targets: pino.TransportTargetOptions[] = [];

  if (opts.pretty && opts.level !== 'silent') {
    targets.push({
      target: 'pino-pretty',
      level: levelToPino(opts.level),
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    });
  } else if (opts.level !== 'silent') {
    targets.push({
      target: 'pino/file',
      level: levelToPino(opts.level),
      options: { destination: 1 },
    });
  }

  if (opts.filePath) {
    targets.push({
      target: 'pino/file',
      level: 'trace',
      options: { destination: opts.filePath },
    });
  }

  const pinoLogger = pino({
    level: levelToPino(opts.level),
    transport: targets.length > 0 ? { targets } : undefined,
  });

  return wrapPinoLogger(pinoLogger, opts.level);
}

function wrapPinoLogger(pinoLogger: pino.Logger, initialLevel?: LogLevel): Logger {
  const levelStr = pinoLogger.level as string;
  let currentLevel: LogLevel = initialLevel ?? (levelStr === 'silent' ? 'silent' : (levelStr as LogLevel));

  return {
    silent: (msg: string, ...args: unknown[]) => {},
    error: (msg: string, ...args: unknown[]) => pinoLogger.error(args.length ? args[0] : msg, msg),
    warn: (msg: string, ...args: unknown[]) => pinoLogger.warn(args.length ? args[0] : msg, msg),
    info: (msg: string, ...args: unknown[]) => pinoLogger.info(args.length ? args[0] : msg, msg),
    debug: (msg: string, ...args: unknown[]) => pinoLogger.debug(args.length ? args[0] : msg, msg),
    trace: (msg: string, ...args: unknown[]) => pinoLogger.trace(args.length ? args[0] : msg, msg),
    setLevel: (level: LogLevel) => {
      currentLevel = level;
      pinoLogger.level = levelToPino(level);
    },
    getLevel: () => currentLevel,
    child: (bindings: Record<string, unknown>) => wrapPinoLogger(pinoLogger.child(bindings), currentLevel),
  };
}

export function createNoopLogger(): Logger {
  return {
    silent: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    setLevel: () => {},
    getLevel: () => 'silent',
    child: () => createNoopLogger(),
  };
}
