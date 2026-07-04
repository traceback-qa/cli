import type { CliContext } from '../types/context.js';

export function createDebugMiddleware(ctx: CliContext) {
  return function debugMiddleware(): void {
    if (ctx.flags.debug) {
      ctx.infra.ui.debug(`CLI version: ${getVersion()}`);
      ctx.infra.ui.debug(`Platform: ${process.platform} ${process.arch}`);
      ctx.infra.ui.debug(`Node.js: ${process.version}`);
      ctx.infra.ui.debug(`Config dir: ${ctx.infra.config.getConfigDir()}`);
    }
  };

  function getVersion(): string {
    return process.env.TRACEBACK_VERSION ?? '0.0.0-development';
  }
}
