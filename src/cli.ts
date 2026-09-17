#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import { bootstrap } from './bootstrap.js';
import { registerGlobalFlags, extractGlobalFlags } from './middleware/global-flags.js';
import { BUILD_INFO } from './build-info.js';
import {
  registerAuthCommands,
  registerWorkspaceCommands,
  registerTestCommands,
  registerProjectCommands,
  registerConfigCommands,
  registerDoctorCommands,
  registerUpdateCommands,
  registerCompletionCommands,
  registerMcpCommands,
  registerMobileCommands,
  registerSetupCommands,
  registerSkillsCommands,
  registerRunsCommands,
} from './commands/index.js';
import type { CliContext } from './types/context.js';

const CONTEXT_KEY = Symbol.for('traceback.cli.context');

function setContext(cmd: Command, ctx: CliContext): void {
  (cmd as unknown as Record<symbol, CliContext>)[CONTEXT_KEY] = ctx;
}

function getContext(cmd: Command): CliContext | undefined {
  let current: Command | undefined = cmd;
  while (current) {
    const ctx = (current as unknown as Record<symbol, CliContext>)[CONTEXT_KEY];
    if (ctx) return ctx;
    current = (current as unknown as { parent?: Command }).parent;
  }
  return undefined;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('traceback')
    .description(
      chalk.hex('#6366F1').bold('Traceback CLI') +
        ' — AI browser & mobile test automation from your terminal',
    )
    .version(BUILD_INFO.version, '-v, --version', 'Output the current version')
    .helpOption('-h, --help', 'Display help for command');

  program.configureHelp({
    subcommandTerm: (cmd) => chalk.cyan.bold(cmd.name()),
    commandUsage: (cmd) => `${chalk.hex('#6366F1').bold(cmd.name())} ${chalk.dim(cmd.usage())}`,
    commandDescription: (cmd) => chalk.white(cmd.description()),
    optionTerm: (opt) => chalk.yellow(opt.flags),
    optionDescription: (opt) => chalk.gray(opt.description),
  });

  registerGlobalFlags(program);

  program.hook('preAction', async (thisCommand, actionCommand) => {
    const globalOpts = extractGlobalFlags(thisCommand.optsWithGlobals());
    const ctx = await bootstrap(globalOpts);
    setContext(actionCommand, ctx);
    setContext(thisCommand, ctx);
  });

  registerAuthCommands(program, getContext);
  registerWorkspaceCommands(program, getContext);
  registerTestCommands(program, getContext);
  registerProjectCommands(program, getContext);
  registerConfigCommands(program, getContext);
  registerDoctorCommands(program, getContext);
  registerUpdateCommands(program, getContext);
  registerCompletionCommands(program, getContext);
  registerMcpCommands(program, getContext);
  registerMobileCommands(program, getContext);
  registerSetupCommands(program, getContext);
  registerSkillsCommands(program, getContext);
  registerRunsCommands(program, getContext);

  program
    .command('login')
    .description('Authenticate with Traceback via browser')
    .alias('signin')
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
          ctx.infra.ui.info(`Logged in as ${chalk.bold.white(account.email || account.accountId)}`);
        }
      } catch (error) {
        spinner.fail('Authentication failed');
        throw error;
      }
    });

  // Launch interactive home menu if invoked with no arguments in a terminal
  if (process.argv.slice(2).length === 0 && process.stdin.isTTY && !process.env.CI) {
    await launchInteractiveHome(program);
    return;
  }

  await program.parseAsync(process.argv);
}

async function launchInteractiveHome(program: Command): Promise<void> {
  const ctx = await bootstrap({
    debug: false,
    silent: false,
    json: false,
    ci: false,
    noColor: false,
  });
  const ui = ctx.infra.ui;
  const isAuth = await ctx.infra.auth.isAuthenticated();
  const account = isAuth ? await ctx.infra.auth.getCurrentAccount() : null;
  const config = await ctx.infra.config.loadGlobalConfig();
  const workspaceId = config.workspaceId;

  const userLabel =
    account?.email ||
    (account?.accountId
      ? `ID: ${account.accountId}`
      : chalk.yellow('Not logged in (run `traceback login`)'));
  const wsLabel = workspaceId ? chalk.cyan.bold(workspaceId) : chalk.dim('None selected');

  ui.box(
    `${chalk.hex('#6366F1').bold('Traceback AI Testing Platform')}\n\n` +
      `  ${chalk.dim('User:')}        ${chalk.white(userLabel)}\n` +
      `  ${chalk.dim('Workspace:')}   ${wsLabel}\n` +
      `  ${chalk.dim('API Host:')}    ${chalk.gray(config.apiUrl || 'https://api.traceback.dev')}`,
    { title: 'Welcome to Traceback', borderColor: '#6366F1' },
  );

  const { select } = await import('@inquirer/prompts');
  const action = await select({
    message: 'What would you like to do?',
    choices: [
      { name: '🧪  Browse & Run Tests (Web & Mobile)', value: 'tests' },
      { name: '📋  Inspect Past Test Runs History', value: 'runs' },
      { name: '🏢  Switch Active Workspace', value: 'workspaces' },
      { name: '🩺  Run System Diagnostics (Doctor)', value: 'doctor' },
      { name: '🔧  Configure Mobile Dependencies (Setup)', value: 'setup' },
      { name: '👤  View Account & Authentication Profile', value: 'auth status' },
      { name: '📖  Show All Commands & CLI Help', value: 'help' },
      { name: chalk.dim('🚪  Exit'), value: 'exit' },
    ],
  });

  if (action === 'exit') {
    return;
  }
  if (action === 'help') {
    program.outputHelp();
    return;
  }

  const args = action.split(' ');
  await program.parseAsync(['node', 'traceback', ...args]);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(
    boxen(
      `${chalk.red.bold('✖ Fatal Error:')} ${message}\n\n${chalk.dim('Run `traceback doctor` or `traceback --help` for assistance.')}`,
      {
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderColor: 'red',
        borderStyle: 'round',
      },
    ),
  );
  process.exit(2);
});

export { getContext, setContext };
