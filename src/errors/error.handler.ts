import { TracebackError, UnexpectedError } from './base.error.js';
import type { CliContext } from '../types/context.js';

export function normalizeError(error: unknown): TracebackError {
  if (error instanceof TracebackError) {
    return error;
  }
  if (error instanceof Error) {
    return new UnexpectedError(error.message, { originalError: error });
  }
  return new UnexpectedError(String(error));
}

export function renderError(
  error: TracebackError,
  ctx: { infra: { ui: CliContext['infra']['ui'] } },
): void {
  ctx.infra.ui.error(error.message);

  if (error.help) {
    ctx.infra.ui.hint(error.help);
  }

  if (error.docsUrl) {
    ctx.infra.ui.hint(`Docs: ${error.docsUrl}`);
  }

  if (ctx.infra.ui.isDebugEnabled()) {
    if (error instanceof UnexpectedError && error.originalError?.stack) {
      ctx.infra.ui.debug(error.originalError.stack);
    }
  }
}

export function handleError(error: unknown, ctx: CliContext): never {
  const tbError = normalizeError(error);

  if (ctx.flags.debug) {
    (ctx.infra.logger as { debug: (msg: string, ...args: unknown[]) => void }).debug(
      `Error: ${tbError.message}`,
    );
  }

  renderError(tbError, ctx);

  process.exit(tbError.statusCode);
}
