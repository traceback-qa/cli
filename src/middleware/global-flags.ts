import type { Command } from 'commander';
import type { CliContext } from '../types/context.js';

export function registerGlobalFlags(program: Command): void {
  program
    .option('-d, --debug', 'Enable debug output', false)
    .option('--silent', 'Disable all output', false)
    .option('--json', 'Output in JSON format', false)
    .option('--no-color', 'Disable color output', false)
    .option('--ci', 'CI mode (non-interactive)', false);
}

export function extractGlobalFlags(options: Record<string, unknown>): {
  debug: boolean;
  silent: boolean;
  json: boolean;
  noColor: boolean;
  ci: boolean;
} {
  return {
    debug: Boolean(options['debug']),
    silent: Boolean(options['silent']),
    json: Boolean(options['json']),
    noColor: !(options['color'] as boolean | undefined ?? true),
    ci: Boolean(options['ci']),
  };
}
