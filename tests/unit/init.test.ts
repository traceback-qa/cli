import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerInitCommands } from '../../src/commands/init/index.js';
import type { CliContext } from '../../src/types/context.js';
import { createUIService } from '../../src/infrastructure/ui/formatting.js';

describe('Init Command', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceback-init-test-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    logSpy.mockRestore();
    cwdSpy.mockRestore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('initializes project configuration and writes traceback.config.json', async () => {
    // Create a mock package.json in tmpDir
    const pkgPath = path.join(tmpDir, 'package.json');
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: 'sample-nextjs-app',
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
      }),
      'utf8',
    );

    const program = new Command();
    const mockCtx: Partial<CliContext> = {
      flags: { ci: true, debug: false, json: false, noColor: true, silent: false },
      infra: {
        ui: createUIService({
          json: false,
          debug: false,
          silent: false,
          noColor: true,
          interactive: false,
        }),
        auth: {
          isAuthenticated: vi.fn().mockResolvedValue(true),
          getCurrentAccount: vi.fn().mockResolvedValue({ email: 'test@traceback.dev' }),
          loginWithBrowser: vi.fn(),
        },
        config: {
          loadGlobalConfig: vi.fn().mockResolvedValue({ workspaceId: 'ws_test_123' }),
        },
        api: {
          get: vi.fn().mockResolvedValue({ data: [{ id: 'ws_test_123', name: 'Test Workspace' }] }),
        },
      } as unknown as CliContext['infra'],
    };

    registerInitCommands(program, () => mockCtx as CliContext);
    await program.parseAsync([
      'node',
      'traceback',
      'init',
      '-y',
      '--workspace',
      'ws_test_123',
      '--no-skills',
    ]);

    const createdConfigPath = path.join(tmpDir, 'traceback.config.json');
    expect(fs.existsSync(createdConfigPath)).toBe(true);

    const savedConfig = JSON.parse(fs.readFileSync(createdConfigPath, 'utf8'));
    expect(savedConfig.name).toBe('sample-nextjs-app');
    expect(savedConfig.framework).toBe('Next.js');
    expect(savedConfig.workspaceId).toBe('ws_test_123');
    expect(savedConfig.platform).toBe('web');
  });
});
