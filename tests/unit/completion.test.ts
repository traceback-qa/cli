import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerCompletionCommands } from '../../src/commands/completion/index.js';
import type { CliContext } from '../../src/types/context.js';
import { createUIService } from '../../src/infrastructure/ui/formatting.js';

describe('Completion Command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('generates zsh completion script', async () => {
    const program = new Command();
    const mockCtx: Partial<CliContext> = {
      infra: {
        ui: createUIService({
          json: false,
          debug: false,
          silent: false,
          noColor: true,
          interactive: false,
        }),
      } as unknown as CliContext['infra'],
    };

    registerCompletionCommands(program, () => mockCtx as CliContext);
    await program.parseAsync(['node', 'traceback', 'completion', 'script', 'zsh']);

    expect(logSpy).toHaveBeenCalled();
    const script = logSpy.mock.calls[0]?.[0];
    expect(script).toContain('#compdef traceback');
    expect(script).toContain('_traceback');
  });

  it('generates bash completion script', async () => {
    const program = new Command();
    const mockCtx: Partial<CliContext> = {
      infra: {
        ui: createUIService({
          json: false,
          debug: false,
          silent: false,
          noColor: true,
          interactive: false,
        }),
      } as unknown as CliContext['infra'],
    };

    registerCompletionCommands(program, () => mockCtx as CliContext);
    await program.parseAsync(['node', 'traceback', 'completion', 'script', 'bash']);

    expect(logSpy).toHaveBeenCalled();
    const script = logSpy.mock.calls[0]?.[0];
    expect(script).toContain('_traceback_completion');
    expect(script).toContain('complete -F _traceback_completion traceback');
  });
});
