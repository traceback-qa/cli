import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';

type ContextGetter = typeof GetContextFn;

export function registerConfigCommands(program: Command, getContext: ContextGetter): void {
  const config = program.command('config').description('Manage configuration');

  config
    .command('get')
    .description('Get a configuration value')
    .argument('<key>', 'Configuration key')
    .action(async function (this: Command, key) {
      const ctx = getContext(this);
      if (!ctx) return;

      const resolved = await ctx.infra.config.loadGlobalConfig();
      const value = (resolved as unknown as Record<string, unknown>)[key];
      if (value === undefined) {
        ctx.infra.ui.warn(`No configuration found for key: ${key}`);
      } else {
        if (ctx.flags.json) {
          ctx.infra.ui.renderJson({ key, value });
        } else {
          ctx.infra.ui.info(`${key}: ${String(value)}`);
        }
      }
    });

  config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Configuration key')
    .argument('<value>', 'Configuration value')
    .action(async function (this: Command, key, value) {
      const ctx = getContext(this);
      if (!ctx) return;

      const coerced = coerceValue(value);
      await ctx.infra.config.setGlobalConfig({ [key]: coerced } as Record<string, unknown> as Parameters<typeof ctx.infra.config.setGlobalConfig>[0]);
      ctx.infra.ui.success(`Set ${key} = ${value}`);
    });

  config
    .command('list')
    .description('List all configuration values')
    .option('--json', 'Output as JSON')
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      const resolved = await ctx.infra.config.loadGlobalConfig();
      if (ctx.flags.json || options['json']) {
        ctx.infra.ui.renderJson(resolved);
        return;
      }
      const entries = Object.entries(resolved as unknown as Record<string, unknown>);
      ctx.infra.ui.table(
        ['Key', 'Value'],
        entries.map(([k, v]) => [k, String(v)]),
      );
    });

  config
    .command('reset')
    .description('Reset configuration to defaults')
    .option('--force', 'Skip confirmation')
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      if (!options['force']) {
        ctx.infra.ui.warn('This will reset all configuration to defaults.');
      }
      ctx.infra.ui.info('Configuration reset is not yet implemented.');
    });
}

function coerceValue(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!Number.isNaN(num)) return num;
  return value;
}
