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
  registerInitCommands,
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

const COMMAND_GROUPS = [
  {
    title: 'CORE COMMANDS',
    commands: [
      { name: 'init', desc: 'Initialize Traceback onboarding in this repository' },
      { name: 'login', desc: 'Authenticate with Traceback via browser' },
      { name: 'whoami', desc: 'Display currently authenticated account' },
      { name: 'workspaces', desc: 'List and switch active Traceback workspace' },
      { name: 'auth', desc: 'Manage authentication sessions and tokens' },
    ],
  },
  {
    title: 'TESTING & VERIFICATION',
    commands: [
      { name: 'tests', desc: 'Browse, run, and watch web and mobile tests' },
      { name: 'mobile', desc: 'Goal-driven mobile app verification against emulators' },
      { name: 'runs', desc: 'Inspect past test runs and execution history' },
    ],
  },
  {
    title: 'AI & MCP INTEGRATIONS',
    commands: [
      { name: 'mcp', desc: 'Start Traceback MCP server for Claude/Cursor/Codex' },
      { name: 'skills', desc: 'Install and manage Traceback agent skills' },
    ],
  },
  {
    title: 'SYSTEM & SETTINGS',
    commands: [
      { name: 'doctor', desc: 'Run diagnostics on local setup and Appium' },
      { name: 'setup', desc: 'Install Appium and platform drivers' },
      { name: 'project', desc: 'Manage projects and test suites' },
      { name: 'config', desc: 'Manage local CLI configuration' },
      { name: 'completion', desc: 'Generate shell completion scripts (zsh, bash, fish)' },
      { name: 'update', desc: 'Check for CLI updates' },
    ],
  },
];

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('traceback')
    .description(
      chalk.hex('#6366F1').bold('Traceback CLI') +
        ' — AI browser & mobile test automation from your terminal',
    )
    .version(BUILD_INFO.version, '-v, --version', 'Output the current version')
    .helpOption('-h, --help', 'Display help for command')
    .showSuggestionAfterError(true);

  // Custom categorized help formatter
  program.helpInformation = function (): string {
    const lines: string[] = [];
    lines.push(
      `${chalk.hex('#6366F1').bold('Traceback CLI')} ${chalk.dim(`v${BUILD_INFO.version}`)} — AI browser & mobile test automation\n`,
    );
    lines.push(`${chalk.bold('USAGE')}`);
    lines.push(
      `  $ ${chalk.hex('#6366F1').bold('traceback')} ${chalk.cyan('<command>')} ${chalk.dim('[options]')}\n`,
    );

    for (const group of COMMAND_GROUPS) {
      lines.push(chalk.bold(group.title));
      for (const cmd of group.commands) {
        const paddedName = cmd.name.padEnd(14, ' ');
        lines.push(`  ${chalk.cyan.bold(paddedName)} ${chalk.gray(cmd.desc)}`);
      }
      lines.push('');
    }

    lines.push(chalk.bold('GLOBAL OPTIONS'));
    lines.push(
      `  ${chalk.yellow('-v, --version'.padEnd(16, ' '))} ${chalk.gray('Output current version')}`,
    );
    lines.push(
      `  ${chalk.yellow('-d, --debug'.padEnd(16, ' '))} ${chalk.gray('Enable verbose debug logs')}`,
    );
    lines.push(`  ${chalk.yellow('--json'.padEnd(16, ' '))} ${chalk.gray('Output pure JSON')}`);
    lines.push(
      `  ${chalk.yellow('--ci'.padEnd(16, ' '))} ${chalk.gray('CI mode (non-interactive)')}`,
    );
    lines.push(`  ${chalk.yellow('--silent'.padEnd(16, ' '))} ${chalk.gray('Disable all output')}`);
    lines.push(
      `  ${chalk.yellow('--no-color'.padEnd(16, ' '))} ${chalk.gray('Disable colored output')}`,
    );
    lines.push(
      `  ${chalk.yellow('-h, --help'.padEnd(16, ' '))} ${chalk.gray('Display help for command')}\n`,
    );

    lines.push(chalk.bold('EXAMPLES'));
    lines.push(`  $ ${chalk.hex('#6366F1')('traceback')} ${chalk.cyan('login')}`);
    lines.push(`  $ ${chalk.hex('#6366F1')('traceback')} ${chalk.cyan('tests')}`);
    lines.push(
      `  $ ${chalk.hex('#6366F1')('traceback')} ${chalk.cyan('mobile verify')} --goal "Verify checkout flow" --platform android`,
    );
    lines.push(`  $ ${chalk.hex('#6366F1')('traceback')} ${chalk.cyan('mcp')}\n`);

    return lines.join('\n');
  };

  registerGlobalFlags(program);

  program.hook('preAction', async (thisCommand, actionCommand) => {
    const globalOpts = extractGlobalFlags(thisCommand.optsWithGlobals());
    const ctx = await bootstrap(globalOpts);
    setContext(actionCommand, ctx);
    setContext(thisCommand, ctx);
  });

  // Post-action check for updates in background
  program.hook('postAction', async (thisCommand) => {
    try {
      const ctx = getContext(thisCommand);
      if (!ctx || ctx.flags.json || ctx.flags.silent || ctx.flags.ci) return;
      if (ctx.infra.update.shouldCheck()) {
        const res = await ctx.infra.update.check();
        if (res?.hasUpdate) {
          ctx.infra.ui.box(
            `${chalk.hex('#6366F1').bold('Update available:')} ${chalk.dim(res.current)} → ${chalk.green.bold(res.latest)}\n` +
              `Run ${chalk.cyan.bold('npm install -g @tracebackai/cli@latest')} to update.`,
            { title: 'Update Available', borderColor: '#6366F1' },
          );
        }
      }
    } catch {
      // Ignore background check failure
    }
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
  registerInitCommands(program, getContext);

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

  const authBadge = isAuth ? ui.badge('LOGGED IN', 'success') : ui.badge('NOT LOGGED IN', 'warn');
  const userLabel =
    account?.email || (account?.accountId ? `ID: ${account.accountId}` : 'Run `traceback login`');
  const wsLabel = workspaceId
    ? chalk.cyan.bold(workspaceId)
    : chalk.dim('None selected (run `traceback workspaces`)');

  ui.box(
    `${chalk.hex('#6366F1').bold('Traceback AI Testing Platform')}  ${authBadge}\n\n` +
      `  ${chalk.dim('User:')}        ${chalk.white(userLabel)}\n` +
      `  ${chalk.dim('Workspace:')}   ${wsLabel}\n` +
      `  ${chalk.dim('API Host:')}    ${chalk.gray(config.apiUrl || 'https://api.traceback.dev')}`,
    { title: 'Welcome to Traceback', borderColor: '#6366F1' },
  );

  const { select } = await import('@inquirer/prompts');
  const action = await select({
    message: 'What would you like to do?',
    choices: [
      { name: '⚡  Initialize Traceback in this Repository (Init)', value: 'init' },
      { name: '🧪  Browse & Run Tests (Web & Mobile)', value: 'tests' },
      { name: '📋  Inspect Past Test Runs History', value: 'runs' },
      { name: '📱  Mobile Verification (Appium)', value: 'mobile' },
      { name: '🏢  Switch Active Workspace', value: 'workspaces' },
      { name: '🩺  Run System Diagnostics (Doctor)', value: 'doctor' },
      { name: '🤖  Start MCP Server (Claude Code / Cursor)', value: 'mcp' },
      { name: '🔧  Configure Mobile Dependencies (Setup)', value: 'setup' },
      { name: '👤  View Account Profile', value: 'whoami' },
      { name: '📖  Show All Commands & Help', value: 'help' },
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
