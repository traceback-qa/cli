/**
 * Align command — Compare PR git diff / Linear tickets with existing specs.
 *
 * Reports clause coverage and identifies uncovered routes or un-specced components.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import { SpecService } from '../../services/spec/index.js';

type ContextGetter = typeof GetContextFn;

interface CliAlignOptions {
  pr?: string;
  linear?: string;
  ci?: boolean;
  json?: boolean;
}

export function registerAlignCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('align [pr]')
    .description('Compare pull request git diff / Linear ticket with qa/ specs for coverage')
    .option('--pr <pr>', 'Pull request number or branch name')
    .option('-l, --linear <ticket>', 'Linear issue identifier (e.g. LIN-1842)')
    .option('--ci', 'CI mode: exit with code 1 if alignment score is below threshold')
    .option('--json', 'Output machine-readable JSON for agents')
    .action(async function (this: Command, prArg?: string, opts: CliAlignOptions = {}) {
      const ctx = getContext(this);
      if (!ctx) return;

      const projectRoot = process.cwd();
      const specService = new SpecService();
      const ui = ctx.infra.ui;

      const isCi = opts.ci || ctx.flags.ci;
      const isJson = opts.json || ctx.flags.json;
      const prTarget = opts.pr || prArg;

      if (!isJson && !ctx.flags.silent) {
        ui.box(
          `${chalk.hex('#6366F1').bold('Traceback QA Spec Alignment')}\n` +
            `  ${chalk.dim('Project:')} ${chalk.white(projectRoot)}\n` +
            `  ${chalk.dim('PR / Ref:')} ${chalk.cyan(prTarget || 'Local uncommitted changes (git diff)')}\n` +
            `  ${chalk.dim('Linear:')}   ${chalk.yellow(opts.linear || 'None specified')}`,
          { title: 'Specification Alignment', borderColor: '#6366F1' },
        );
      }

      const spinner = ui.spinner('Analyzing git diff and aligning against qa/ specs...');

      try {
        const result = await specService.align(projectRoot, {
          pr: prTarget,
          linear: opts.linear,
          ci: isCi,
          json: isJson,
        });

        spinner.stop();

        if (isJson) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
        } else if (!ctx.flags.silent) {
          const scoreBadge =
            result.score >= 80
              ? chalk.green.bold(`${result.score}%`)
              : result.score >= 60
                ? chalk.yellow.bold(`${result.score}%`)
                : chalk.red.bold(`${result.score}%`);

          // eslint-disable-next-line no-console
          console.log(`\nAlignment Score: ${scoreBadge} (Clause Coverage: ${result.coveragePct}%)`);
          // eslint-disable-next-line no-console
          console.log(`Specs: ${result.coveredClauses}/${result.totalClauses} clauses covering modified paths\n`);

          if (result.modifiedFiles.length > 0) {
            // eslint-disable-next-line no-console
            console.log(chalk.bold('Modified Application Files:'));
            for (const f of result.modifiedFiles) {
              const isUncovered = result.uncoveredRoutes.includes(f);
              const icon = isUncovered ? chalk.red('  ✗ (uncovered)') : chalk.green('  ✓ (covered)');
              // eslint-disable-next-line no-console
              console.log(`${icon} ${f}`);
            }
          }

          if (result.uncoveredRoutes.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`\n${chalk.yellow.bold('⚠ Uncovered Routes / Components:')}`);
            for (const r of result.uncoveredRoutes) {
              // eslint-disable-next-line no-console
              console.log(`  • ${chalk.yellow(r)}`);
            }
            ui.hint('Run `traceback explore <url>` or draft a clause in `qa/clauses/` to cover these files.');
          }

          // eslint-disable-next-line no-console
          console.log('\n' + chalk.dim('─'.repeat(60)));
          if (result.passed) {
            ui.success(result.message);
          } else {
            ui.error(result.message);
          }
        }

        if (isCi && !result.passed) {
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        spinner.fail('Alignment analysis failed');
        if (isJson) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ error: errorMsg, passed: false }));
        } else {
          ui.error(errorMsg);
        }
        if (isCi) {
          process.exitCode = 1;
        }
      }
    });
}
