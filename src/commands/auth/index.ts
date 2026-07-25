import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';

type ContextGetter = typeof GetContextFn;

export function registerAuthCommands(program: Command, getContext: ContextGetter): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('login')
    .description('Authenticate with Traceback via browser')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      ctx.infra.ui.info('Opening browser for authentication...');
      const spinner = ctx.infra.ui.spinner('Waiting for approval...');

      try {
        await ctx.infra.auth.loginWithBrowser();
        spinner.succeed('Authentication successful');

        const account = await ctx.infra.auth.getCurrentAccount();
        if (account) {
          ctx.infra.ui.info(`Logged in as ${account.email || account.accountId}`);
        }
      } catch (error) {
        spinner.fail('Authentication failed');
        throw error;
      }
    });

  auth
    .command('logout')
    .description('Log out of Traceback')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      const spinner = ctx.infra.ui.spinner('Logging out...');
      try {
        await ctx.infra.auth.logout();
        spinner.succeed('Logged out successfully');
      } catch (error) {
        spinner.fail('Logout failed');
        throw error;
      }
    });

  auth
    .command('status')
    .description('Show authentication status')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      const isAuth = await ctx.infra.auth.isAuthenticated();
      if (isAuth) {
        const account = await ctx.infra.auth.getCurrentAccount();
        if (account) {
          ctx.infra.ui.success(`Authenticated as ${account.email || account.accountId}`);
        } else {
          ctx.infra.ui.success('Authenticated');
        }
      } else {
        ctx.infra.ui.warn('Not authenticated');
        ctx.infra.ui.hint('Run `traceback login` to authenticate.');
      }
    });

  auth
    .command('whoami')
    .description('Show current user')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      const account = await ctx.infra.auth.getCurrentAccount();
      if (!account) {
        ctx.infra.ui.warn('Not authenticated');
        return;
      }
      ctx.infra.ui.info(account.email || account.accountId);
    });
}
