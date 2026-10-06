import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerMobileConnectCommand } from '../../../src/commands/mobile/connect.js';

describe('mobile connect command', () => {
  it('registers the connect subcommand with correct description and options', () => {
    const parent = new Command('mobile');
    const getContext = vi.fn();

    registerMobileConnectCommand(parent, getContext);

    const connectCmd = parent.commands.find((c) => c.name() === 'connect');
    expect(connectCmd).toBeDefined();
    expect(connectCmd?.description()).toContain(
      'Connect this machine as a local mobile test execution bridge',
    );

    const options = connectCmd?.options.map((o) => o.flags);
    expect(options).toContain('--workspace <id>');
    expect(options).toContain('--appium-url <url>');
  });
});
