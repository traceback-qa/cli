/**
 * Verify command — Run local and preview spec verification against qa/ specs.
 *
 * Evaluates local qa/clauses/*.md and qa/journeys/*.yaml against localhost:3000
 * or preview URLs across Desktop (1280x800) and Mobile (390x844) viewports.
 *
 * Supports --ci with GitHub Actions annotations and --json for AI agents.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import { SpecService, type VerifyOptions } from '../../services/spec/index.js';

type ContextGetter = typeof GetContextFn;

interface CliVerifyOptions {
  url?: string;
  ci?: boolean;
  json?: boolean;
  viewport?: 'desktop' | 'mobile' | 'all';
  clause?: string;
  journey?: string;
}

export function registerVerifyCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('verify [target]')
    .description('Verify local dev server or preview URL against qa/ specifications')
    .option('-u, --url <url>', 'Target base URL (e.g. http://localhost:3000 or preview URL)')
    .option('--ci', 'CI mode: emit GitHub Actions annotations and exit 1 on sacred failure')
    .option('--json', 'Output machine-readable JSON for coding agents')
    .option('--viewport <viewport>', 'Viewport to verify: desktop, mobile, or all', 'all')
    .option('--clause <slug>', 'Verify only specific clause slug')
    .option('--journey <slug>', 'Verify only specific journey slug')
    .action(async function (this: Command, target?: string, opts: CliVerifyOptions = {}) {
      const ctx = getContext(this);
      if (!ctx) return;

      const projectRoot = process.cwd();
      const specService = new SpecService();
      const ui = ctx.infra.ui;

      const isCi = opts.ci || ctx.flags.ci;
      const isJson = opts.json || ctx.flags.json;

      const verifyOptions: VerifyOptions = {
        target,
        url: opts.url,
        ci: isCi,
        json: isJson,
        viewport: opts.viewport,
        clause: opts.clause,
        journey: opts.journey,
      };

      if (!isJson && !ctx.flags.silent) {
        ui.box(
          `${chalk.hex('#6366F1').bold('Traceback QA Spec Verification')}\n` +
            `  ${chalk.dim('Project Root:')} ${chalk.white(projectRoot)}\n` +
            `  ${chalk.dim('Target:')}       ${chalk.cyan(opts.url || target || 'Auto-detected local dev server')}\n` +
            `  ${chalk.dim('Viewports:')}    ${chalk.yellow(opts.viewport || 'desktop (1280x800), mobile (390x844)')}\n` +
            `  ${chalk.dim('Mode:')}         ${chalk.magenta(isCi ? 'CI (Strict Gating)' : 'Interactive Local')}`,
          { title: 'Spec Verification', borderColor: '#6366F1' },
        );
      }

      const spinner = ui.spinner('Compiling and executing spec journeys...');

      try {
        const summary = await specService.verify(projectRoot, verifyOptions);
        spinner.stop();

        if (isJson) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(summary, null, 2));
        } else if (!ctx.flags.silent) {
          // Render results summary
          for (const run of summary.runs) {
            const statusIcon = run.status === 'passed' ? chalk.green('✔ PASS') : chalk.red('✖ FAIL');
            const vpBadge = chalk.dim(`[${run.viewport.name} ${run.viewport.width}x${run.viewport.height}]`);
            // eslint-disable-next-line no-console
            console.log(`\n${statusIcon} ${chalk.bold(run.journeyIntent)} ${vpBadge}`);

            for (const step of run.steps) {
              const stepIcon = step.status === 'passed' ? chalk.green('  ✓') : chalk.red('  ✗');
              const stepTarget = step.target ? ` ${chalk.cyan(step.target)}` : '';
              // eslint-disable-next-line no-console
              console.log(`${stepIcon} ${step.action}${stepTarget} ${chalk.dim(`(${step.durationMs}ms)`)}`);
              if (step.error) {
                // eslint-disable-next-line no-console
                console.log(`    ${chalk.red('→')} ${step.error}`);
              }
            }

            if (run.sacredViolation) {
              // eslint-disable-next-line no-console
              console.log(chalk.red.bold(`  ✖ SACRED CLAUSE VIOLATION: Covered sacred clauses failed verification.`));
            }
          }

          // eslint-disable-next-line no-console
          console.log('\n' + chalk.dim('─'.repeat(60)));
          const stats =
            `Journeys: ${chalk.bold(summary.passedJourneys)}/${summary.totalJourneys} passed, ` +
            `Clauses: ${chalk.bold(summary.coveredClauses)}/${summary.totalClauses} covered, ` +
            `Sacred Violations: ${summary.sacredViolations > 0 ? chalk.red.bold(summary.sacredViolations) : chalk.green('0')}, ` +
            `Time: ${chalk.dim(`${summary.durationMs}ms`)}`;

          if (summary.passed) {
            ui.success(`Verification Passed! ${stats}`);
          } else {
            ui.error(`Verification Failed! ${stats}`);
          }
        }

        // Emit GitHub Actions annotations in CI mode
        if (isCi && summary.annotations.length > 0) {
          for (const annotation of summary.annotations) {
            // eslint-disable-next-line no-console
            console.log(annotation);
          }
        }

        if (isCi && !summary.passed) {
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        spinner.fail('Verification encountered an unexpected error');
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
