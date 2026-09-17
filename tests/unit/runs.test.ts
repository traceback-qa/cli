import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerRunsCommands } from '../../src/commands/runs/index.js';
import type { CliContext } from '../../src/types/context.js';
import { createUIService } from '../../src/infrastructure/ui/formatting.js';

describe('Runs Command', () => {
  it('registers runs command and handles json listing', async () => {
    const program = new Command();
    const renderJsonSpy = vi.fn();
    const ui = createUIService({
      json: true,
      debug: false,
      silent: false,
      noColor: true,
      interactive: false,
    });
    ui.renderJson = renderJsonSpy;

    const mockCtx: Partial<CliContext> = {
      infra: {
        ui,
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        auth: {
          isAuthenticated: vi.fn().mockResolvedValue(true),
          getToken: vi.fn().mockResolvedValue({ accessToken: 'mock_token' }),
        },
        config: {
          loadGlobalConfig: vi.fn().mockResolvedValue({ workspaceId: 'ws-123' }),
        },
        api: {
          setAuthToken: vi.fn(),
          get: vi.fn().mockResolvedValue({
            data: [
              {
                id: 'run-1',
                status: 'PASSED',
                test_name: 'Smoke Test',
                duration_seconds: 4.5,
              },
            ],
          }),
        },
      } as unknown as CliContext['infra'],
    };

    registerRunsCommands(program, () => mockCtx as CliContext);
    await program.parseAsync(['node', 'traceback', 'runs', '--json']);

    expect(renderJsonSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'run-1', status: 'PASSED' })]),
    );
  });
});
