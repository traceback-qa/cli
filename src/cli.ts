#!/usr/bin/env node
import { Command } from 'commander';
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
    .description('Traceback CLI — trace, debug, and fix production issues')
    .version(BUILD_INFO.version, '-v, --version', 'Output the current version')
    .helpOption('-h, --help', 'Display help for command');

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
          ctx.infra.ui.info(`Logged in as ${account.email || account.accountId}`);
        }
      } catch (error) {
        spinner.fail('Authentication failed');
        throw error;
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  if (error instanceof Error) {
    // eslint-disable-next-line no-console -- last-resort fatal handler, no ctx/logger available here
    console.error(`Fatal error: ${error.message}`);
  } else {
    // eslint-disable-next-line no-console -- last-resort fatal handler, no ctx/logger available here
    console.error(`Fatal error: ${String(error)}`);
  }
  process.exit(2);
});

export { getContext, setContext };
