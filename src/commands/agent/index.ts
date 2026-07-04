import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';

type ContextGetter = typeof GetContextFn;

export function registerAgentCommands(program: Command, getContext: ContextGetter): void {
  const agent = program.command('agent').description('Manage agents');

  agent
    .command('list')
    .description('List agents')
    .option('--json', 'Output as JSON')
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      const spinner = ctx.infra.ui.spinner('Fetching agents...');
      try {
        const agents = await ctx.services.agent.list();
        spinner.stop();

        if (ctx.flags.json || options['json']) {
          ctx.infra.ui.renderJson(agents);
          return;
        }

        if ((agents as Array<{ name: string; id: string; status: string }>).length === 0) {
          ctx.infra.ui.info('No agents found.');
          return;
        }

        ctx.infra.ui.table(
          ['Name', 'ID', 'Status'],
          (agents as Array<{ name: string; id: string; status: string }>).map((a) => [
            a.name,
            a.id,
            a.status,
          ]),
        );
      } catch (error) {
        spinner.fail('Failed to fetch agents');
        throw error;
      }
    });
}
