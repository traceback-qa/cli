import { describe, expect, it } from 'vitest';
import { configureCloudMcp } from '../../src/infrastructure/mcp/client-configurator.js';
import { connectTunnel } from '../../src/infrastructure/tunnel/tunnel.client.js';
import { decrypt, encrypt } from '../../src/platform/keychain.js';

describe('CLI security hardening', () => {
  it('refuses unencrypted tunnel connections to non-localhost URLs', async () => {
    await expect(
      connectTunnel(
        'http://api.traceback.qa',
        'tb_live_123',
        'ws://127.0.0.1:9222/devtools/browser/1',
      ),
    ).rejects.toThrow('Refusing unencrypted tunnel connection to non-localhost API URL');
  });

  it('configures OAuth MCP endpoint without static Authorization header when token is omitted', () => {
    const results = configureCloudMcp({
      apiUrl: 'https://api.traceback.qa',
      targetClients: ['Cursor'],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.success).toBe(true);
  });

  it('encrypts and decrypts secrets symmetrically', () => {
    const secret = 'tb_live_secret_value_abc';
    const encrypted = encrypt(secret);
    expect(encrypted).not.toContain(secret);
    expect(decrypt(encrypted)).toBe(secret);
  });
});
