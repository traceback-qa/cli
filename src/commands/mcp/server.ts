import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { z } from 'zod';
import type { CliContext } from '../../types/context.js';

let activeWorkspaceId: string | null = null;
let activeWorkspaceName: string | null = null;

export async function startMcpServer(ctx: CliContext | undefined): Promise<void> {
  const server = new McpServer({
    name: 'traceback',
    version: '0.1.0',
  });

  const api = ctx?.infra.api;

  // Pre-load active workspace from global config if configured
  if (ctx?.infra.config) {
    try {
      const config = await ctx.infra.config.loadGlobalConfig();
      if (config.workspaceId) {
        activeWorkspaceId = config.workspaceId;
      }
    } catch {}
  }

  // Allow env override for MCP (e.g. when testing locally)
  const envApiUrl = process.env.TRACEBACK_API_URL;
  if (envApiUrl && api) {
    api.setBaseUrl(envApiUrl);
  }

  // ── Workspace tools ──────────────────────────────────────

  server.tool('list_workspaces', 'List all workspaces the user has access to', {}, async () => {
    if (!api)
      return {
        content: [{ type: 'text', text: 'Not authenticated. Run `traceback auth login` first.' }],
      };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- workspace list shape not modeled client-side
      const res = await api.get<any[]>('/api/v1/workspaces');
      const workspaces = res.data;
      const lines = workspaces
        .map((w: Record<string, unknown>) => {
          const id = String(w.workspace_id ?? w.id ?? '');
          const activeMarker = id === activeWorkspaceId ? ' (active)' : '';
          return `• ${w.name} (${id})${activeMarker}`;
        })
        .join('\n');
      return { content: [{ type: 'text', text: lines || 'No workspaces found.' }] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  server.tool(
    'select_workspace',
    'Select a workspace to use for all subsequent operations',
    { workspace_id: z.string().describe('The workspace ID to select') },
    async ({ workspace_id }) => {
      if (!api) return { content: [{ type: 'text', text: 'Not authenticated.' }] };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- workspace shape not modeled client-side
        const res = await api.get<any>(`/api/v1/workspaces/${workspace_id}`);
        activeWorkspaceId = workspace_id;
        activeWorkspaceName = res.data?.name || workspace_id;
        return {
          content: [
            {
              type: 'text',
              text: `Workspace "${activeWorkspaceName}" selected. All subsequent operations will use this workspace.`,
            },
          ],
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool('current_workspace', 'Show the currently selected workspace', {}, async () => {
    if (!activeWorkspaceId) {
      return {
        content: [{ type: 'text', text: 'No workspace selected. Use select_workspace first.' }],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `Current workspace: ${activeWorkspaceName} (${activeWorkspaceId})`,
        },
      ],
    };
  });

  // ── Verification tool ────────────────────────────────────

  server.tool(
    'verify_implementation',
    'Verify an implementation against a specific goal and URL. For localhost URLs, automatically launches a browser tunnel. Proactively call this tool immediately after making any UI code changes to verify your work is correct.',
    {
      goal: z.string().min(1).describe('The goal or criteria to verify the implementation against'),
      url: z.string().min(1).describe('The URL of the implementation to verify'),
    },
    async ({ goal, url }) => {
      if (!api) return { content: [{ type: 'text', text: 'Not authenticated.' }] };
      if (!activeWorkspaceId) {
        return {
          content: [{ type: 'text', text: 'No workspace selected. Call select_workspace first.' }],
        };
      }

      // Normalize bare URLs — agents often omit the scheme (e.g. "localhost:3000")
      const normalizedUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
      let tunnelId: string | undefined;
      let cleanup: (() => Promise<void>) | undefined;

      try {
        const tunnel = await launchTunnel(ctx);
        tunnelId = tunnel.tunnelId;
        cleanup = tunnel.cleanup;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- verify-implementation response shape not modeled client-side
        const res = await api.post<any>(
          `/api/v1/workspaces/${activeWorkspaceId}/mcp/verify-implementation`,
          { goal, url: normalizedUrl, tunnel_id: tunnelId },
          { timeout: 300_000 }, // 5 minutes — agent may take a while
        );

        const data = res.data;
        const lines: string[] = [];

        if (data.status === 'complete') {
          lines.push(data.passed ? '✅ PASSED' : '❌ FAILED');
          lines.push(`Steps: ${data.steps_passed}/${data.steps_total} passed`);
          lines.push(`Duration: ${data.duration_ms}ms`);
          if (data.steps) {
            lines.push('');
            for (const s of data.steps) {
              const icon = s.status === 'passed' ? '✓' : '✗';
              lines.push(`  ${icon} ${s.description}`);
              if (s.failure_reason) lines.push(`    → ${s.failure_reason}`);
            }
          }
          if (data.llm_stats) {
            lines.push('');
            lines.push(
              `LLM: ${data.llm_stats.llm_calls} calls, ${data.llm_stats.total_tokens} tokens, $${data.llm_stats.estimated_cost_usd}`,
            );
          }
        } else if (data.status === 'error') {
          lines.push(`Error: ${data.message}`);
        } else {
          lines.push(JSON.stringify(data, null, 2));
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } finally {
        if (cleanup) await cleanup();
      }
    },
  );

  server.tool(
    'verify_mobile_implementation',
    'Verify a mobile app implementation against a specific natural language goal on a connected iOS simulator or Android emulator.',
    {
      goal: z
        .string()
        .min(1)
        .describe('The natural language goal or criteria to verify on the mobile device'),
      platform: z
        .enum(['ios', 'android'])
        .optional()
        .describe('Mobile platform (ios or android). Auto-detected if omitted.'),
      app_identifier: z
        .string()
        .optional()
        .describe('App bundle ID (iOS) or package name (Android), e.g. com.example.app'),
    },
    async ({ goal, platform, app_identifier }) => {
      if (!api) return { content: [{ type: 'text', text: 'Not authenticated.' }] };
      if (!activeWorkspaceId) {
        return {
          content: [{ type: 'text', text: 'No workspace selected. Call select_workspace first.' }],
        };
      }

      const { detectDevices } = await import('../../infrastructure/mobile/device.detector.js');
      const { devices } = detectDevices();
      if (!devices.length) {
        return {
          content: [
            {
              type: 'text',
              text: 'No running iOS simulator or Android emulator found. Please start a simulator (e.g. `open -a Simulator`) or emulator first.',
            },
          ],
        };
      }

      const selectedDevice = platform
        ? devices.find((d) => d.platform === platform) || devices[0]
        : devices[0];
      if (!selectedDevice) {
        return {
          content: [
            {
              type: 'text',
              text: 'No running iOS simulator or Android emulator found.',
            },
          ],
        };
      }
      const { startAppiumBridge } = await import('../../infrastructure/mobile/appium.bridge.js');
      const token = ctx ? await ctx.infra.auth.getToken() : null;
      if (!token?.accessToken) {
        return { content: [{ type: 'text', text: 'Not authenticated.' }] };
      }

      const config = ctx?.infra.config
        ? await ctx.infra.config.loadGlobalConfig()
        : { apiUrl: 'http://localhost:8000' };
      let bridge;
      try {
        bridge = await startAppiumBridge({
          apiBaseUrl: config.apiUrl,
          authToken: token.accessToken,
          deviceId: selectedDevice.id,
          platform: selectedDevice.platform,
          deviceName: selectedDevice.name,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to connect to mobile device via Appium: ${message}`,
            },
          ],
        };
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mobile-start response shape
        const res = await api.post<any>(
          `/api/v1/workspaces/${activeWorkspaceId}/mcp/mobile-start`,
          {
            goal,
            platform: selectedDevice.platform,
            trigger_type: 'MCP',
            device_name: selectedDevice.name,
            session_id: bridge.sessionId,
            app_identifier,
          },
          { timeout: 300_000 },
        );

        return {
          content: [
            {
              type: 'text',
              text: `Mobile verification run initiated (ID: ${res.data?.run_id}). Target: ${selectedDevice.name} (${selectedDevice.platform.toUpperCase()}). Goal: "${goal}"`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error starting mobile verification: ${message}` }],
        };
      } finally {
        if (bridge) await bridge.close();
      }
    },
  );

  server.tool(
    'create_test',
    'Create a new, permanent test definition in the Traceback workspace.',
    {
      name: z.string().min(1).describe('A short, descriptive name for the test'),
      goal: z
        .string()
        .min(1)
        .describe(
          'The natural language instructions for the agent (e.g. "Verify the submit button exists")',
        ),
    },
    async ({ name, goal }) => {
      if (!api) return { content: [{ type: 'text', text: 'Not authenticated.' }] };
      if (!activeWorkspaceId) {
        return {
          content: [{ type: 'text', text: 'No workspace selected. Call select_workspace first.' }],
        };
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- created-test response shape not modeled client-side
        const res = await api.post<any>(`/api/v1/workspaces/${activeWorkspaceId}/tests`, {
          name,
          goal,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Test "${name}" created successfully (ID: ${res.data.id}).`,
            },
          ],
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  // ── Resources ────────────────────────────────────────────

  server.resource(
    'Traceback Test Coverage',
    'traceback://tests',
    {
      description:
        'Read this resource to view all existing test definitions in the current Traceback workspace. Useful to understand test coverage before creating new tests.',
    },
    async (uri) => {
      if (!api) throw new Error('Not authenticated.');
      if (!activeWorkspaceId) throw new Error('No workspace selected.');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test list response shape not modeled client-side
      const res = await api.get<any>(`/api/v1/workspaces/${activeWorkspaceId}/tests`);
      const tests = Array.isArray(res.data) ? res.data : res.data.data || [];

      if (tests.length === 0) {
        return {
          contents: [
            {
              uri: uri.href,
              text: 'No tests found in this workspace.',
            },
          ],
        };
      }

      const lines = tests.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test list response shape not modeled client-side
        (t: any) => `# ${t.name} (ID: ${t.id})\nGoal: ${t.definition || t.goal || ''}\n`,
      );
      return {
        contents: [
          {
            uri: uri.href,
            text: lines.join('\n'),
          },
        ],
      };
    },
  );

  // ── Prompts ──────────────────────────────────────────────

  server.prompt(
    'traceback_tdd',
    'Adopt a Test-Driven Development (TDD) workflow with Traceback',
    {},
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'You are a TDD coding assistant. For every UI task, you must follow a strict process: write the code, and then immediately use the `verify_implementation` tool to verify your changes work in the browser. Do not stop until the verification passes.',
          },
        },
      ],
    }),
  );

  // ── Start stdio transport ────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function launchTunnel(
  ctx: CliContext | undefined,
): Promise<{ tunnelId: string; cleanup: () => Promise<void> }> {
  const { spawn } = await import('child_process');
  const { WebSocket } = await import('ws');

  // Check if Chrome is already running on port 9222
  let alreadyRunning = false;
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version');
    if (res.ok) alreadyRunning = true;
  } catch {}

  if (!alreadyRunning) {
    const chromePath = findChrome();
    if (!chromePath)
      throw new Error('Chrome not found. Install Google Chrome to use verification.');

    // Launch Chrome with CDP
    if (process.platform === 'darwin') {
      execSync(
        'open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/traceback-chrome-profile --no-first-run --no-default-browser-check about:blank',
      );
      try {
        execSync(
          'osascript -e \'tell application "Google Chrome" to activate\' -e \'tell application "System Events" to set frontmost of process "Google Chrome" to true\'',
        );
      } catch {}
    } else {
      spawn(
        chromePath,
        [
          '--remote-debugging-port=9222',
          '--no-first-run',
          '--no-default-browser-check',
          '--user-data-dir=/tmp/traceback-chrome-profile',
          'about:blank',
        ],
        { stdio: 'ignore', detached: true },
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  } else if (process.platform === 'darwin') {
    try {
      execSync(
        'osascript -e \'tell application "Google Chrome" to activate\' -e \'tell application "System Events" to set frontmost of process "Google Chrome" to true\'',
      );
    } catch {}
  }

  // Connect tunnel
  const baseUrl = ctx?.infra.api.getAxiosInstance().defaults.baseURL || 'http://localhost:8000';
  const auth = ctx ? await ctx.infra.auth.getToken() : null;
  const token = auth?.accessToken || '';
  const wsUrl =
    baseUrl.replace('https://', 'wss://').replace('http://', 'ws://') +
    `/tunnel/connect?token=${token}`;

  const ws = new WebSocket(wsUrl);

  const tunnelId = await new Promise<string>((resolve, reject) => {
    let pendingTunnelId = '';
    const timeout = setTimeout(() => reject(new Error('Tunnel connection timeout')), 10000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws message payload shape not modeled client-side
    ws.on('message', async (raw: any) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') {
        pendingTunnelId = msg.tunnel_id;
        try {
          // Keep trying to fetch the CDP URL until Chrome is ready
          let cdpUrl = '';
          for (let i = 0; i < 10; i++) {
            try {
              const res = await fetch('http://127.0.0.1:9222/json/version');
              if (res.ok) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP /json/version response shape not modeled client-side
                const data = (await res.json()) as any;
                if (data && data.webSocketDebuggerUrl) {
                  cdpUrl = data.webSocketDebuggerUrl;
                  break;
                }
              }
            } catch (e) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          if (!cdpUrl) throw new Error('Could not get CDP URL from Chrome');
          ws.send(JSON.stringify({ type: 'cdp_ready', cdp_url: cdpUrl }));
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      } else if (msg.type === 'cdp_ack') {
        clearTimeout(timeout);
        resolve(pendingTunnelId);
      }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws error shape not modeled client-side
    ws.on('error', (err: any) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const cleanup = async () => {
    try {
      ws.close();
    } catch {}
  };

  return { tunnelId, cleanup };
}

function findChrome(): string | null {
  if (process.platform === 'darwin') {
    const path = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(path)) return path;
  } else if (process.platform === 'win32') {
    for (const p of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]) {
      if (existsSync(p)) return p;
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      try {
        const p = execSync(`which ${name}`, { encoding: 'utf8' }).trim();
        if (p) return p;
      } catch {}
    }
  }
  return null;
}
