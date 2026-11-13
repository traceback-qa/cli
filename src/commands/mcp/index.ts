import type { Command } from 'commander';
import chalk from 'chalk';
import type { CliContext } from '../../types/context.js';
import {
  configureCloudMcp,
  getSupportedMcpClients,
} from '../../infrastructure/mcp/client-configurator.js';

type ContextGetter = (cmd: Command) => CliContext | undefined;

export function registerMcpCommands(program: Command, getContext: ContextGetter): void {
  const mcpCmd = program
    .command('mcp')
    .description('Start or configure the Traceback MCP server for AI coding agents')
    .action(async function (this: Command) {
      const ctx = getContext(this);

      // MCP runs in stdio mode — suppress all CLI output
      const { startMcpServer } = await import('./server.js');
      await startMcpServer(ctx);
    });

  mcpCmd
    .command('install')
    .description(
      'Install Traceback Cloud MCP endpoint into Cursor, Claude Desktop, Windsurf, and VS Code',
    )
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option(
      '--with-token',
      'Embed a static Bearer token in IDE config instead of using browser OAuth',
      false,
    )
    .action(async function (this: Command, options: { yes?: boolean; withToken?: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;
      const ui = ctx.infra.ui;

      ui.banner('Traceback MCP Installer', 'AI Agent & IDE Auto-Configurator');

      const token = options.withToken ? await ctx.infra.auth.getToken() : null;
      const config = await ctx.infra.config.loadGlobalConfig();
      const apiUrl = config.apiUrl;

      const detected = getSupportedMcpClients();
      const available = detected.filter((c) => c.detected);

      if (available.length > 0) {
        ui.info(
          `Detected ${available.length} installed AI client(s): ${available.map((c) => chalk.bold(c.name)).join(', ')}`,
        );
      } else {
        ui.info('Configuring standard AI clients (Cursor & Claude Desktop)...');
      }

      const results = configureCloudMcp({
        token: token?.accessToken,
        apiUrl,
      });

      ui.hint('');
      for (const res of results) {
        if (res.success) {
          ui.success(`${chalk.bold(res.clientName)}: Configured → ${chalk.dim(res.configPath)}`);
        } else {
          ui.error(`${chalk.bold(res.clientName)}: Failed (${res.error})`);
        }
      }

      ui.hint('');
      if (options.withToken && !token?.accessToken) {
        ui.warn(
          'Note: No active login session found. Run `traceback login` or connect via OAuth in your IDE.',
        );
      } else if (!options.withToken) {
        ui.info(
          'Configured for OAuth — your AI IDE will prompt you to sign in via Traceback when connecting.',
        );
      }

      ui.success(
        'Traceback Cloud MCP configuration complete! Restart your AI IDE to start using Traceback.',
      );
    });
}
