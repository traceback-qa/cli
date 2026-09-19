import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';

type ContextGetter = typeof GetContextFn;

export function registerUpdateCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('update')
    .description('Check for updates')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      const spinner = ctx.infra.ui.spinner('Checking for updates...');
      try {
        const result = await ctx.infra.update.check();
        spinner.stop();

        if (!result) {
          ctx.infra.ui.warn('Could not check for updates.');
          return;
        }

        if (result.hasUpdate) {
          ctx.infra.ui.box(
            `New version available!\n\n` +
              `  Current: ${result.current}\n` +
              `  Latest:  ${result.latest}\n` +
              `  Type:    ${result.type}\n\n` +
              `Run \`npm install -g @tracebackai/cli@latest\` to update.`,
            { title: 'Update Available' },
          );
        } else {
          ctx.infra.ui.success(`You're up to date! (${result.current})`);
        }
      } catch (error) {
        spinner.fail('Update check failed');
        throw error;
      }
    });
}
