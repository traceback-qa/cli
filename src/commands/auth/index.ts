import type { Command } from 'commander';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import type { CliContext } from '../../types/context.js';

type ContextGetter = typeof GetContextFn;

export function registerAuthCommands(program: Command, getContext: ContextGetter): void {
  const auth = program.command('auth').description('Manage authentication and account sessions');

  auth
    .command('login')
    .description('Authenticate with Traceback via browser')
    .alias('signin')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;
      await handleLogin(ctx);
    });

  auth
    .command('logout')
    .description('Log out of Traceback')
    .alias('signout')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      const spinner = ctx.infra.ui.spinner('Logging out...');
      try {
        await ctx.infra.auth.logout();
        spinner.succeed('Logged out successfully.');
      } catch (error) {
        spinner.fail('Logout failed.');
        throw error;
      }
    });

  auth
    .command('status')
    .description('Show current authentication status and account details')
    .option('--json', 'Output status as JSON')
    .action(async function (this: Command, options: { json?: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;
      await showAuthProfile(ctx, options.json);
    });

  auth
    .command('whoami')
    .description('Show current authenticated user')
    .option('--json', 'Output user info as JSON')
    .action(async function (this: Command, options: { json?: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;
      await showAuthProfile(ctx, options.json);
    });

  // Also register top-level `traceback whoami` shortcut
  program
    .command('whoami')
    .description('Display currently authenticated Traceback account')
    .option('--json', 'Output user info as JSON')
    .action(async function (this: Command, options: { json?: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;
      await showAuthProfile(ctx, options.json);
    });
}

export async function handleLogin(ctx: CliContext): Promise<void> {
  const ui = ctx.infra.ui;
  ui.info('Opening browser for authentication...');
  const spinner = ui.spinner('Waiting for browser authentication approval...');

  try {
    await ctx.infra.auth.loginWithBrowser();
    spinner.succeed('Authentication successful!');

    const account = await ctx.infra.auth.getCurrentAccount();
    if (account) {
      ui.success(`Logged in as ${chalk.bold.white(account.email || account.accountId)}`);
    }
  } catch (error) {
    spinner.fail('Authentication failed.');
    throw error;
  }
}

async function showAuthProfile(ctx: CliContext, isJson?: boolean): Promise<void> {
  const ui = ctx.infra.ui;
  const isAuth = await ctx.infra.auth.isAuthenticated();
  const config = await ctx.infra.config.loadGlobalConfig();

  if (!isAuth) {
    if (isJson || ui.isJsonMode()) {
      ui.renderJson({ authenticated: false });
      return;
    }

    ui.box(
      `${chalk.yellow.bold('⚠ Not Authenticated')}\n\n` +
        `  You are currently not logged in to Traceback.\n\n` +
        `  Run ${chalk.cyan.bold('traceback login')} to authenticate via your browser.`,
      { title: 'Authentication', borderColor: 'yellow' },
    );
    return;
  }

  const account = await ctx.infra.auth.getCurrentAccount();
  const workspaceId = config.workspaceId || 'None (run `traceback workspaces`)';
  const apiUrl = config.apiUrl || 'https://api.traceback.dev';

  if (isJson || ui.isJsonMode()) {
    ui.renderJson({
      authenticated: true,
      account: account || null,
      workspaceId: config.workspaceId || null,
      apiUrl,
    });
    return;
  }

  const userEmail = account?.email || 'Authenticated User';
  const accountId = account?.accountId ? ` (${chalk.dim(account.accountId)})` : '';
  const statusBadge = ui.badge('ACTIVE SESSION', 'success');

  ui.box(
    `${chalk.bold.hex('#6366F1')('👤 Account Profile')}\n\n` +
      `  ${chalk.dim('User:')}        ${chalk.white.bold(userEmail)}${accountId}\n` +
      `  ${chalk.dim('Workspace:')}   ${chalk.cyan(workspaceId)}\n` +
      `  ${chalk.dim('API Host:')}    ${chalk.gray(apiUrl)}\n` +
      `  ${chalk.dim('Status:')}      ${statusBadge}`,
    { title: 'Traceback Identity', borderColor: '#6366F1' },
  );
}
