import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getSupportedMcpClients,
  configureCloudMcp,
} from '../../src/infrastructure/mcp/client-configurator.js';

describe('MCP Client Configurator', () => {
  const tempDir = path.join(os.tmpdir(), `traceback-mcp-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lists supported MCP clients', () => {
    const clients = getSupportedMcpClients();
    expect(clients.length).toBeGreaterThan(0);
    expect(clients.some((c) => c.name === 'Cursor')).toBe(true);
    expect(clients.some((c) => c.name === 'Claude Desktop')).toBe(true);
  });

  it('safely configures cloud MCP server in config files', () => {
    const mockConfigPath = path.join(tempDir, 'mcp.json');
    fs.writeFileSync(
      mockConfigPath,
      JSON.stringify({
        mcpServers: {
          existingServer: { command: 'node', args: ['server.js'] },
        },
      }),
      'utf-8',
    );

    const results = configureCloudMcp({
      token: 'tb_test_token_123',
      apiUrl: 'https://api.traceback.dev',
      targetClients: ['Cursor'],
    });

    expect(results.length).toBeGreaterThan(0);
    const cursorResult = results.find((r) => r.clientName === 'Cursor');
    expect(cursorResult?.success).toBe(true);

    if (cursorResult?.configPath && fs.existsSync(cursorResult.configPath)) {
      const content = JSON.parse(fs.readFileSync(cursorResult.configPath, 'utf-8'));
      expect(content.mcpServers?.traceback).toBeDefined();
      expect(content.mcpServers.traceback.url).toBe('https://api.traceback.dev/mcp');
      expect(content.mcpServers.traceback.headers?.Authorization).toBe('Bearer tb_test_token_123');
    }
  });
});
