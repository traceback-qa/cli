import type { CliContext } from '../types/context.js';
import type { ResolvedFlags } from '../types/context.js';

export function resolveFlags(opts: {
  debug: boolean;
  silent: boolean;
  json: boolean;
  noColor: boolean;
  ci: boolean;
}): ResolvedFlags {
  return {
    debug: opts.debug || process.env.TRACEBACK_DEBUG === '1',
    silent: opts.silent || process.env.TRACEBACK_SILENT === '1',
    json: opts.json || process.env.TRACEBACK_JSON === '1',
    ci: opts.ci || Boolean(process.env.CI),
    noColor: opts.noColor || process.env.NO_COLOR === '1' || process.env.TRACEBACK_NO_COLOR === '1',
  };
}

export function injectContextHandler(ctx: CliContext) {
  return function injectContext(this: { cliContext?: CliContext }): void {
    this.cliContext = ctx;
  };
}
