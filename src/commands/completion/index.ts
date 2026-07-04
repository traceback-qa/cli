import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';

type ContextGetter = typeof GetContextFn;

export function registerCompletionCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('completion')
    .description('Generate shell completion script')
    .argument('[shell]', 'Shell type: bash, zsh, fish, powershell')
    .action(function (this: Command, shell: string | undefined) {
      const ctx = getContext(this);
      if (!ctx) return;

      const targetShell = shell ?? detectShell();
      ctx.infra.ui.info(`To set up ${targetShell} completion:`);
      ctx.infra.ui.hint(
        `Add the following to your shell config:\n` +
          `  eval "$(traceback completion ${targetShell})"`,
      );
    });
}

function detectShell(): string {
  return process.env.SHELL?.split('/').pop() ?? 'bash';
}
