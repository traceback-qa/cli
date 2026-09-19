import type { Command } from 'commander';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';

type ContextGetter = typeof GetContextFn;

export function registerDoctorCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('doctor')
    .description('Run diagnostics on your Traceback setup')
    .option('-f, --fix', 'Automatically run setup to fix missing dependencies', false)
    .option('-y, --yes', 'Skip confirmation prompts when fixing', false)
    .action(async function (this: Command, options: { fix?: boolean; yes?: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;

      const ui = ctx.infra.ui;
      ui.banner('Traceback Doctor', 'System & Environment Diagnostics');

      const spinner = ui.spinner('Analyzing environment and dependencies...');
      const results = await ctx.services.doctor.runDiagnostics();
      spinner.stop();

      let okCount = 0;
      let warnCount = 0;
      let errCount = 0;

      for (const result of results) {
        if (result.status === 'ok') {
          okCount++;
          ui.success(result.message);
        } else if (result.status === 'warning') {
          warnCount++;
          ui.warn(result.message);
          if (result.suggestion) {
            ui.hint(chalk.yellow(`↳ Suggestion: ${result.suggestion}`));
          }
        } else {
          errCount++;
          ui.error(result.message);
          if (result.suggestion) {
            ui.hint(chalk.red(`↳ Fix: ${result.suggestion}`));
          }
        }
      }

      ui.hint('');
      if (errCount === 0 && warnCount === 0) {
        ui.success(`All ${okCount} diagnostics passed cleanly. Your environment is fully ready!`);
        return;
      }

      if (errCount === 0) {
        ui.warn(
          `${okCount} passed, ${warnCount} warning(s). Traceback should work, but check suggestions above.`,
        );
      } else {
        ui.errorCard(
          'Diagnostics Incomplete',
          `Found ${errCount} error(s) and ${warnCount} warning(s).`,
          results
            .filter((r) => r.status === 'error' && r.suggestion)
            .map((r) => r.suggestion as string),
          { docsUrl: 'https://docs.traceback.dev/troubleshooting' },
        );
      }

      // Check if auto-fix is available
      const needsSetup = results.some((r) => r.suggestion?.includes('traceback setup'));
      if (needsSetup && !ctx.flags.ci && !ctx.flags.json) {
        let shouldFix = options.fix || options.yes;
        if (!shouldFix) {
          const { confirm } = await import('@inquirer/prompts');
          shouldFix = await confirm({
            message:
              'Would you like to run `traceback setup` now to auto-fix missing mobile tooling?',
            default: true,
          });
        }

        if (shouldFix) {
          ui.info('Launching Traceback automated setup...');
          const setupCmd = program.commands.find((c) => c.name() === 'setup');
          if (setupCmd) {
            await setupCmd.parseAsync(['node', 'traceback', 'setup', '-y']);
          }
        }
      }
    });
}
