import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  registerInitCommands,
  registerVerifyCommands,
  registerExploreCommands,
  registerAlignCommands,
  registerHealCommands,
} from '../../src/commands/index.js';
import type { CliContext } from '../../src/types/context.js';
import { createUIService } from '../../src/infrastructure/ui/formatting.js';

describe('V2 CLI Commands', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-commands-test-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    logSpy.mockRestore();
    cwdSpy.mockRestore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockContext(): CliContext {
    return {
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
          getToken: vi.fn().mockResolvedValue({ accessToken: 'test-token' }),
        },
        config: {
          loadGlobalConfig: vi.fn().mockResolvedValue({ workspaceId: 'ws_test_123' }),
        },
        api: {
          get: vi.fn().mockResolvedValue({ data: [{ id: 'ws_test_123', name: 'Test Workspace' }] }),
          post: vi.fn().mockResolvedValue({ data: { success: true } }),
        },
      } as unknown as CliContext['infra'],
    } as CliContext;
  }

  it('init command scaffolds qa/ specs and configures workspace', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'storefront-app', dependencies: { next: '^14.0.0' } }),
    );

    const program = new Command();
    const ctx = createMockContext();
    registerInitCommands(program, () => ctx);

    await program.parseAsync(['node', 'traceback', 'init', '-y', '--no-skills', '--no-mcp']);

    expect(fs.existsSync(path.join(tmpDir, 'qa', 'surface.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'qa', 'policy.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'qa', 'clauses', 'sample.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'qa', 'journeys', 'smoke.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'traceback.config.json'))).toBe(true);
  });

  it('verify command runs spec verification and supports --json', async () => {
    // Scaffold specs first
    fs.mkdirSync(path.join(tmpDir, 'qa', 'clauses'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'qa', 'journeys'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'qa', 'clauses', 'smoke.md'),
      '---\nid: smoke\nsacred: true\n---\n# Smoke\n- [ ] Ready',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'qa', 'journeys', 'smoke.yaml'),
      'id: smoke\nintent: Smoke\ncovers: [smoke]\nsteps:\n  - goto /',
    );

    const program = new Command();
    const ctx = createMockContext();
    registerVerifyCommands(program, () => ctx);

    await program.parseAsync(['node', 'traceback', 'verify', '--json', '--url', 'http://127.0.0.1:59999']);

    expect(logSpy).toHaveBeenCalled();
  });

  it('explore command crawls and generates draft specs', async () => {
    const program = new Command();
    const ctx = createMockContext();
    registerExploreCommands(program, () => ctx);

    await program.parseAsync(['node', 'traceback', 'explore', 'http://localhost:3000', '--out', path.join(tmpDir, 'qa')]);

    expect(fs.existsSync(path.join(tmpDir, 'qa', 'clauses'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'qa', 'journeys'))).toBe(true);
  });

  it('align command runs git and linear alignment analysis', async () => {
    const program = new Command();
    const ctx = createMockContext();
    registerAlignCommands(program, () => ctx);

    await program.parseAsync(['node', 'traceback', 'align', '--pr', '99', '--linear', 'LIN-42']);

    expect(logSpy).toHaveBeenCalled();
  });

  it('heal command analyzes fragile selectors and supports dry run', async () => {
    fs.mkdirSync(path.join(tmpDir, 'qa', 'journeys'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'qa', 'journeys', 'sample.yaml'),
      'id: sample\nintent: Sample\nsteps:\n  - click: "#btn-987654"',
    );

    const program = new Command();
    const ctx = createMockContext();
    registerHealCommands(program, () => ctx);

    await program.parseAsync(['node', 'traceback', 'heal', '--dry-run']);

    expect(logSpy).toHaveBeenCalled();
  });
});
