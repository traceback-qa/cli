import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';

type ContextGetter = typeof GetContextFn;

interface Workspace {
  workspace_id?: string;
  id?: string;
  name: string;
  plan?: string;
}

export function registerWorkspaceCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('workspaces')
    .description('Select a workspace')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      const isAuth = await ctx.infra.auth.isAuthenticated();
      if (!isAuth) {
        ctx.infra.ui.warn('Not authenticated. Run `traceback login` first.');
        return;
      }

      const spinner = ctx.infra.ui.spinner('Fetching workspaces...');
      let workspaces: Workspace[];
      try {
        const result = await ctx.infra.api.get<Workspace[]>('/api/v1/workspaces');
        workspaces = result.data;
        spinner.stop();
      } catch (error) {
        spinner.fail('Failed to fetch workspaces');
        throw error;
      }

      if (!workspaces.length) {
        ctx.infra.ui.warn('No workspaces found. Create one at traceback.dev');
        return;
      }

      // Get current selection
      const config = await ctx.infra.config.loadGlobalConfig();
      const currentId = config.workspaceId;

      const { select } = await import('@inquirer/prompts');
      const answer = await select({
        message: 'Select a workspace',
        choices: workspaces.map((w) => {
          const id = w.workspace_id ?? w.id ?? '';
          return {
            name: id === currentId ? `${w.name}  ← active` : w.name,
            value: id,
          };
        }),
        default: currentId,
      });

      await ctx.infra.config.setGlobalConfig({ workspaceId: answer });
      const selected = workspaces.find((w) => (w.workspace_id ?? w.id) === answer);
      ctx.infra.ui.success(`Active workspace: ${selected?.name ?? answer}`);
    });
}
