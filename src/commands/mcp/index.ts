import type { Command } from 'commander';
import type { CliContext } from '../../types/context.js';

type ContextGetter = (cmd: Command) => CliContext | undefined;

export function registerMcpCommands(
  program: Command,
  getContext: ContextGetter,
): void {
  program
    .command('mcp')
    .description('Start the Traceback MCP server for AI agent integrations')
    .action(async function (this: Command) {
      const ctx = getContext(this);

      // MCP runs in stdio mode — suppress all CLI output
      const { startMcpServer } = await import('./server.js');
      await startMcpServer(ctx);
    });
}
