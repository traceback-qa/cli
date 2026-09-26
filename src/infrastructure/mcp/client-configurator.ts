/**
 * MCP Client Configurator
 *
 * Automatically detects and configures Cloud MCP endpoints for AI coding clients
 * (Cursor, Claude Desktop, Windsurf, VS Code).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_API_URL } from '../../constants/urls.js';

export interface McpClientDefinition {
  name: string;
  configPath: string;
  detected: boolean;
}

export interface ConfigureMcpResult {
  clientName: string;
  configPath: string;
  success: boolean;
  error?: string;
}

/**
 * Returns candidate MCP config file paths for common AI clients across platforms.
 */
export function getSupportedMcpClients(): McpClientDefinition[] {
  const home = os.homedir();
  const clients: { name: string; paths: string[] }[] = [];

  // 1. Cursor
  clients.push({
    name: 'Cursor',
    paths: [path.join(home, '.cursor', 'mcp.json'), path.join(home, '.cursor-tutor', 'mcp.json')],
  });

  // 2. Claude Desktop
  let claudeConfig = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') {
    claudeConfig = path.join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    claudeConfig = path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  clients.push({
    name: 'Claude Desktop',
    paths: [claudeConfig],
  });

  // 3. Windsurf
  clients.push({
    name: 'Windsurf',
    paths: [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
  });

  // 4. VS Code (project or user)
  clients.push({
    name: 'VS Code',
    paths: [path.join(home, '.vscode', 'mcp.json')],
  });

  const results: McpClientDefinition[] = [];
  for (const client of clients) {
    let resolvedPath: string = client.paths[0] || '';
    let detected = false;

    for (const candidate of client.paths) {
      if (fs.existsSync(candidate) || fs.existsSync(path.dirname(candidate))) {
        resolvedPath = candidate;
        detected = true;
        break;
      }
    }

    results.push({
      name: client.name,
      configPath: resolvedPath,
      detected,
    });
  }

  return results;
}

/**
 * Configure the Traceback Cloud MCP endpoint in all detected or selected AI clients.
 */
export function configureCloudMcp(options?: {
  token?: string;
  apiUrl?: string;
  targetClients?: string[];
}): ConfigureMcpResult[] {
  const baseUrl = options?.apiUrl || DEFAULT_API_URL;
  const mcpUrl = `${baseUrl.replace(/\/+$/, '')}/mcp`;
  const headers: Record<string, string> = {};

  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const tracebackServerConfig = {
    url: mcpUrl,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };

  const allClients = getSupportedMcpClients();
  const clientsToConfigure = options?.targetClients?.length
    ? allClients.filter((c) => options.targetClients?.includes(c.name))
    : allClients.filter((c) => c.detected);

  // If none detected yet, include Cursor and Claude Desktop as standard targets
  const effectiveClients = clientsToConfigure.length
    ? clientsToConfigure
    : allClients.filter((c) => ['Cursor', 'Claude Desktop'].includes(c.name));

  const results: ConfigureMcpResult[] = [];

  for (const client of effectiveClients) {
    try {
      const configDir = path.dirname(client.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      let parsedConfig: { mcpServers?: Record<string, unknown> } = {};
      if (fs.existsSync(client.configPath)) {
        try {
          const raw = fs.readFileSync(client.configPath, 'utf-8');
          parsedConfig = JSON.parse(raw);
        } catch {
          parsedConfig = {};
        }
      }

      if (!parsedConfig.mcpServers || typeof parsedConfig.mcpServers !== 'object') {
        parsedConfig.mcpServers = {};
      }

      parsedConfig.mcpServers['traceback'] = tracebackServerConfig;

      fs.writeFileSync(client.configPath, JSON.stringify(parsedConfig, null, 2) + '\n', 'utf-8');
      results.push({
        clientName: client.name,
        configPath: client.configPath,
        success: true,
      });
    } catch (err) {
      results.push({
        clientName: client.name,
        configPath: client.configPath,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
