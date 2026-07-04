import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';

type ContextGetter = typeof GetContextFn;

export function registerDoctorCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('doctor')
    .description('Run diagnostics on your Traceback setup')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      ctx.infra.ui.info('Running diagnostics...\n');

      const results = await ctx.services.doctor.runDiagnostics();

      for (const result of results) {
        const icon =
          result.status === 'ok'
            ? ctx.infra.ui.success
            : result.status === 'warning'
              ? ctx.infra.ui.warn
              : ctx.infra.ui.error;

        icon.call(ctx.infra.ui, result.message);
        if (result.suggestion) {
          ctx.infra.ui.hint(result.suggestion);
        }
      }
    });
}
