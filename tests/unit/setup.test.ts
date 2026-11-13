import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerSetupCommands } from '../../src/commands/setup/index.js';
import type { CliContext } from '../../src/types/context.js';

describe('setup command', () => {
  it('registers setup command with options', () => {
    const program = new Command();
    const mockContext = {
      infra: {
        ui: {
          banner: vi.fn(),
          step: vi.fn(),
          info: vi.fn(),
          success: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          hint: vi.fn(),
          table: vi.fn(),
          spinner: vi.fn(() => ({ stop: vi.fn(), succeed: vi.fn(), fail: vi.fn() })),
        },
      },
    } as unknown as CliContext;

    registerSetupCommands(program, () => mockContext);

    const setupCmd = program.commands.find((c) => c.name() === 'setup');
    expect(setupCmd).toBeDefined();
    expect(setupCmd?.options.some((o) => o.flags.includes('--platform'))).toBe(true);
    expect(setupCmd?.options.some((o) => o.flags.includes('--yes'))).toBe(true);
    expect(setupCmd?.options.some((o) => o.flags.includes('--quick'))).toBe(true);
    expect(setupCmd?.options.some((o) => o.flags.includes('--skip-wda'))).toBe(true);
    expect(setupCmd?.options.some((o) => o.flags.includes('--skip-mcp'))).toBe(true);
  });
});
