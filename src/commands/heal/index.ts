/**
 * Heal command — Safe locator auto-repair for qa/** journey files.
 *
 * Analyzes failure artifacts and fragile DOM selectors, proposing or applying
 * resilient semantic locator replacements according to qa/policy.yaml.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import { SpecService } from '../../services/spec/index.js';

type ContextGetter = typeof GetContextFn;

interface CliHealOptions {
  runId?: string;
  file?: string;
  apply?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export function registerHealCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('heal [run_id]')
    .description('Analyze failure artifacts and apply safe locator patches to qa/** journeys')
    .option('-r, --run-id <id>', 'Specific run ID or artifact to heal')
    .option('-f, --file <path>', 'Specific journey file to inspect and heal')
    .option('--apply', 'Apply proposed locator patches directly to files', false)
    .option('--dry-run', 'Preview proposed diffs without writing to disk', false)
    .option('--json', 'Output proposals in machine-readable JSON format for agents')
    .action(async function (this: Command, runIdArg?: string, opts: CliHealOptions = {}) {
      const ctx = getContext(this);
      if (!ctx) return;

      const projectRoot = process.cwd();
      const specService = new SpecService();
      const ui = ctx.infra.ui;

      const isJson = opts.json || ctx.flags.json;
      const runId = opts.runId || runIdArg;
      const shouldApply = opts.apply && !opts.dryRun;

      if (!isJson && !ctx.flags.silent) {
        ui.box(
          `${chalk.hex('#6366F1').bold('Traceback QA Spec Healer')}\n` +
            `  ${chalk.dim('Project:')}   ${chalk.white(projectRoot)}\n` +
            `  ${chalk.dim('Target Run:')} ${chalk.cyan(runId || 'Latest failure artifacts')}\n` +
            `  ${chalk.dim('Action:')}     ${chalk.yellow(shouldApply ? 'Apply Patches' : 'Dry Run (Preview Diffs)')}`,
          { title: 'Safe Locator Healer', borderColor: '#6366F1' },
        );
      }

      const spinner = ui.spinner('Analyzing failure artifacts and evaluating locator repair candidates...');

      try {
        const result = await specService.heal(projectRoot, {
          runId,
          file: opts.file,
          apply: shouldApply,
          dryRun: opts.dryRun,
          json: isJson,
        });

        spinner.stop();

        if (isJson) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
        } else if (!ctx.flags.silent) {
          if (!result.policyAllowed) {
            ui.warn(result.message);
            return;
          }

          if (result.proposals.length === 0) {
            ui.success(result.message);
            return;
          }

          ui.info(`Generated ${chalk.bold(result.proposals.length)} locator repair proposal(s):`);

          for (const p of result.proposals) {
            // eslint-disable-next-line no-console
            console.log(`\n  ${chalk.bold(p.filePath)} (${chalk.green(`Confidence: ${Math.round(p.confidence * 100)}%`)})`);
            // eslint-disable-next-line no-console
            console.log(`  Reason: ${chalk.dim(p.reason)}`);
            // eslint-disable-next-line no-console
            console.log(`  ${chalk.red(`- ${p.originalSelector}`)}`);
            // eslint-disable-next-line no-console
            console.log(`  ${chalk.green(`+ ${p.suggestedSelector}`)}`);
          }

          // eslint-disable-next-line no-console
          console.log('\n' + chalk.dim('─'.repeat(60)));
          if (shouldApply) {
            ui.success(`Successfully applied ${result.appliedCount} locator patch(es)!`);
          } else {
            ui.info(`Dry run complete. Run with ${chalk.cyan.bold('traceback heal --apply')} to apply patches.`);
          }
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        spinner.fail('Heal analysis failed');
        if (isJson) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ error: errorMsg }));
        } else {
          ui.error(errorMsg);
        }
        process.exitCode = 1;
      }
    });
}
