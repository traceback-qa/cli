/**
 * Explore command — Crawl application URL and auto-generate draft specs.
 *
 * Discovers interactive controls, links, and forms, then generates draft
 * `qa/clauses/*.md` and `qa/journeys/*.yaml` files.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import type { getContext as GetContextFn } from '../../cli.js';
import { SpecService } from '../../services/spec/index.js';

type ContextGetter = typeof GetContextFn;

interface CliExploreOptions {
  out?: string;
  depth?: string;
  json?: boolean;
  dryRun?: boolean;
}

export function registerExploreCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('explore <url>')
    .description('Crawl target URL and generate draft qa/clauses/*.md and qa/journeys/*.yaml')
    .option('-o, --out <dir>', 'Output directory for generated specs', 'qa')
    .option('-d, --depth <number>', 'Crawl exploration depth', '1')
    .option('--dry-run', 'Generate draft specs to stdout without writing files')
    .option('--json', 'Output discovered elements and generated specs as JSON')
    .action(async function (this: Command, url: string, opts: CliExploreOptions) {
      const ctx = getContext(this);
      if (!ctx) return;

      const specService = new SpecService();
      const ui = ctx.infra.ui;
      const isJson = opts.json || ctx.flags.json;
      const depth = parseInt(opts.depth || '1', 10);

      if (!isJson && !ctx.flags.silent) {
        ui.box(
          `${chalk.hex('#6366F1').bold('Traceback QA Explorer & Spec Generator')}\n` +
            `  ${chalk.dim('Target URL:')} ${chalk.cyan(url)}\n` +
            `  ${chalk.dim('Output:')}     ${chalk.white(opts.out || 'qa/')}\n` +
            `  ${chalk.dim('Depth:')}      ${chalk.yellow(depth)}\n` +
            `  ${chalk.dim('Dry Run:')}    ${chalk.dim(opts.dryRun ? 'Yes (stdout only)' : 'No (writes to disk)')}`,
          { title: 'Explore & Generate Specs', borderColor: '#6366F1' },
        );
      }

      const spinner = ui.spinner(`Exploring ${url} and discovering interactive controls...`);

      try {
        const result = await specService.explore(url, {
          outDir: opts.out,
          depth,
          dryRun: opts.dryRun,
          json: isJson,
        });

        spinner.stop();

        if (isJson) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
        } else if (!ctx.flags.silent) {
          ui.success(`Exploration complete! Discovered ${chalk.bold(result.routesDiscovered.length)} route(s):`);

          for (const route of result.routesDiscovered) {
            // eslint-disable-next-line no-console
            console.log(`\n  ${chalk.cyan.bold(route.path)} — "${route.title}"`);
            // eslint-disable-next-line no-console
            console.log(`    Discovered ${chalk.yellow(route.elements.length)} interactive element(s):`);
            for (const el of route.elements.slice(0, 8)) {
              // eslint-disable-next-line no-console
              console.log(`      • [${chalk.dim(el.type)}] ${chalk.white(el.label)} ${chalk.dim(el.selector)}`);
            }
          }

          // eslint-disable-next-line no-console
          console.log('\n' + chalk.dim('─'.repeat(60)));
          ui.info(`Generated ${chalk.bold(result.clausesGenerated.length)} clause(s) & ${chalk.bold(result.journeysGenerated.length)} journey(s):`);

          for (const c of result.clausesGenerated) {
            const rel = path.relative(process.cwd(), c.filePath);
            ui.hint(`Created clause: ${chalk.green(rel || c.filePath)}`);
          }
          for (const j of result.journeysGenerated) {
            const rel = path.relative(process.cwd(), j.filePath);
            ui.hint(`Created journey: ${chalk.green(rel || j.filePath)}`);
          }

          ui.emptyState(
            '🎯 What to do next:',
            'Review the generated specs and run verification:',
            [
              { label: 'Verify generated specs', command: `traceback verify --url ${url}` },
              { label: 'Inspect clauses', command: 'cat qa/clauses/*.md' },
            ],
          );
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        spinner.fail('Exploration failed');
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
