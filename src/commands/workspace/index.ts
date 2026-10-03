import type { Command } from 'commander';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';

type ContextGetter = typeof GetContextFn;

import type { StoredToken } from '../../infrastructure/auth/auth.types.js';

interface Workspace {
  workspace_id?: string;
  id?: string;
  name: string;
  slug?: string;
  plan?: string;
}

export function registerWorkspaceCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('workspaces')
    .description('List and switch active Traceback workspace')
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
          const isActive = id === currentId;
          const planBadge = w.plan ? chalk.dim(` [${w.plan}]`) : '';
          const statusBadge = isActive ? chalk.cyan.bold(' ● active') : '';

          return {
            name: `${chalk.bold(w.name)}${planBadge}${statusBadge}`,
            value: id,
          };
        }),
        default: currentId,
      });

      await ctx.infra.config.setGlobalConfig({ workspaceId: answer });
      const selected = workspaces.find((w) => (w.workspace_id ?? w.id) === answer);
      ctx.infra.ui.success(
        `Active workspace switched to: ${chalk.bold.cyan(selected?.name ?? answer)}`,
      );

      const token = await ctx.infra.auth.getToken();
      if (token && token.workspaceId && token.workspaceId !== answer) {
        const keySpinner = ctx.infra.ui.spinner(
          `Configuring access key for ${selected?.name ?? answer}...`,
        );
        try {
          const keyRes = await ctx.infra.api.post<{
            api_key_id: string;
            raw_key: string;
          }>('/api/v1/auth/api-keys', {
            workspace_id: answer,
            name: `CLI — ${selected?.name ?? answer}`,
            scopes: [
              'tests:read',
              'tests:write',
              'runs:read',
              'runs:execute',
              'test_run:*',
              'scenario:*',
              'project:*',
            ],
          });

          if (keyRes.data?.raw_key) {
            const newToken: StoredToken = {
              ...token,
              accessToken: keyRes.data.raw_key,
              workspaceId: answer,
              workspaceSlug: selected?.slug || selected?.name || answer,
              issuedAt: Date.now(),
            };
            await ctx.infra.authStore.set(newToken);
            ctx.infra.api.setAuthToken(newToken.accessToken);
            keySpinner.succeed(
              `Session authenticated for ${chalk.bold.cyan(selected?.name ?? answer)}.`,
            );
            return;
          }
        } catch {
          keySpinner.stop();
        }

        ctx.infra.ui.warn(
          `Your active session token is scoped to workspace "${token.workspaceSlug || token.workspaceId}".`,
        );
        ctx.infra.ui.hint(
          'Run `traceback login` to authenticate and generate a key for this workspace.',
        );
      }
    });
}
