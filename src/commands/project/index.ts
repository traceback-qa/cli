import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';

type ContextGetter = typeof GetContextFn;

export function registerProjectCommands(program: Command, getContext: ContextGetter): void {
  const project = program.command('project').description('Manage projects');

  project
    .command('list')
    .description('List projects')
    .option('--json', 'Output as JSON')
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      const spinner = ctx.infra.ui.spinner('Fetching projects...');
      try {
        const projects = await ctx.services.project.list();
        spinner.stop();

        if (ctx.flags.json || options['json']) {
          ctx.infra.ui.renderJson(projects);
          return;
        }

        if ((projects as Array<{ name: string; id: string; status: string }>).length === 0) {
          ctx.infra.ui.info('No projects found.');
          ctx.infra.ui.hint('Run `traceback project init` to create one.');
          return;
        }

        ctx.infra.ui.table(
          ['Name', 'ID', 'Status'],
          (projects as Array<{ name: string; id: string; status: string }>).map((p) => [
            p.name,
            p.id,
            p.status,
          ]),
        );
      } catch (error) {
        spinner.fail('Failed to fetch projects');
        throw error;
      }
    });

  project
    .command('get')
    .description('Get project details')
    .argument('<id>', 'Project ID')
    .option('--json', 'Output as JSON')
    .action(async function (this: Command, id, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      const spinner = ctx.infra.ui.spinner('Fetching project...');
      try {
        const project = await ctx.services.project.get(id);
        spinner.stop();
        if (ctx.flags.json || options['json']) {
          ctx.infra.ui.renderJson(project);
        } else {
          ctx.infra.ui.success(`Project: ${(project as { name: string }).name}`);
        }
      } catch (error) {
        spinner.fail('Failed to fetch project');
        throw error;
      }
    });

  project
    .command('delete')
    .description('Delete a project')
    .argument('<id>', 'Project ID')
    .option('--force', 'Skip confirmation')
    .action(async function (this: Command, id, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      if (!options['force']) {
        ctx.infra.ui.warn(`This will permanently delete project ${id}.`);
      }
      const spinner = ctx.infra.ui.spinner('Deleting project...');
      try {
        await ctx.services.project.delete(id);
        spinner.succeed('Project deleted');
      } catch (error) {
        spinner.fail('Failed to delete project');
        throw error;
      }
    });
}
