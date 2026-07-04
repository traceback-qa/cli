export function exit(code: number): never {
  process.exit(code);
}

export function onShutdown(handler: (signal: NodeJS.Signals) => void): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    process.on(signal, handler);
  }
}

export function isInteractive(): boolean {
  return process.stdout.isTTY && !process.env.CI && !process.env.TRACEBACK_CI;
}

export function isCI(): boolean {
  return Boolean(process.env.CI || process.env.TRACEBACK_CI);
}

export function getEnvFlag(name: string): string | undefined {
  return process.env[`TRACEBACK_${name.toUpperCase()}`];
}

export function getEnvBoolFlag(name: string): boolean | undefined {
  const val = getEnvFlag(name);
  if (val === undefined) return undefined;
  return val === '1' || val === 'true' || val === 'yes' || val === 'on';
}
