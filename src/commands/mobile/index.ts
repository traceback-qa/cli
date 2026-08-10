import type { Command } from 'commander';
import type { CliContext } from '../../types/context.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { registerMobileDevCommands } from './dev.js';

type ContextGetter = (cmd: Command) => CliContext | undefined;

const MAX_STEPS = 15;
const DEFAULT_APPIUM_URL = 'http://localhost:4723';

export function registerMobileCommands(program: Command, getContext: ContextGetter): void {
  const mobile = program
    .command('mobile')
    .description('Mobile app verification — cloud-driven AI testing against a connected device');

  // `dev`/`test` — Mode 1: a persistent cloud emulator + live-reload tunnel, registered as
  // siblings of `verify` below rather than folded into it (different lifecycle entirely: one
  // long-lived foreground session instead of a single provision-run-teardown call).
  registerMobileDevCommands(mobile, getContext);

  mobile
    .command('verify')
    .description(
      'Verify a mobile app against a natural-language goal.\n' +
        'The backend runs the AI agent in the cloud. The CLI sends screen XML\n' +
        'and executes returned gestures locally via Appium.',
    )
    .requiredOption('-g, --goal <text>', 'Natural-language verification goal')
    .requiredOption('-p, --platform <platform>', 'Platform: android or ios')
    .option('--apk <path>', 'Path to APK (Android)')
    .option('--app <path>', 'Path to .app bundle (iOS)')
    .option('--device <name>', 'Device/emulator name')
    .option('--os-version <version>', 'OS version to target')
    .option('--package <pkg>', 'Android app package (e.g. com.example.app)')
    .option('--activity <activity>', 'Android launch activity')
    .option('--deep-link <uri>', 'Deep link to navigate to on start')
    .option('--appium-url <url>', 'Appium server URL', DEFAULT_APPIUM_URL)
    .option('--workspace <id>', 'Workspace ID (defaults to current)')
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      const api = ctx.infra.api;
      const ui = ctx.infra.ui;
      const logger = ctx.infra.logger;

      // ── Resolve workspace ──────────────────────────────
      let workspaceId = options['workspace'];
      if (!workspaceId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- activeWorkspaceId isn't part of CliContext's declared shape
        const ctxWithSession = ctx as any;
        workspaceId = ctxWithSession.activeWorkspaceId;
        if (!workspaceId) {
          ui.error(
            'No workspace selected. Use --workspace <id> or:\n  traceback workspaces select',
          );
          return;
        }
      }

      // ── Start the mobile relay ─────────────────────────
      const relayPath = findRelayPath();
      if (!relayPath) {
        ui.error(
          'Could not find the Python mobile relay script.\n' +
            'Clone the backend repo next to the CLI repo, or set TRACEBACK_BACKEND_PATH.\n' +
            'Expected: backend/scripts/mobile_relay.py',
        );
        return;
      }

      logger?.debug(`Starting mobile relay: ${relayPath}`);

      const relay = spawn('python3', [relayPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      relay.on('error', (err: Error) => {
        ui.error(`Relay process error: ${err.message}`);
      });

      // Line-buffered reader for the relay's stdout
      let buffer = '';
      let relayExited = false;

      relay.on('close', () => {
        relayExited = true;
      });
      relay.on('error', () => {
        relayExited = true;
      });

      const readLine = (): Promise<string> => {
        return new Promise((resolve, reject) => {
          // Check if we already have a complete line in the buffer
          const newlineIdx = buffer.indexOf('\n');
          if (newlineIdx !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            resolve(line);
            return;
          }

          // If the relay already exited and we have nothing buffered, reject.
          if (relayExited) {
            reject(new Error('Relay process exited unexpectedly'));
            return;
          }

          const onData = (chunk: Buffer) => {
            buffer += chunk.toString();
            const idx = buffer.indexOf('\n');
            if (idx !== -1) {
              const line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 1);
              cleanup();
              resolve(line);
            }
          };

          const onClose = () => {
            cleanup();
            reject(new Error('Relay process exited while waiting for response'));
          };

          const cleanup = () => {
            relay.stdout!.removeListener('data', onData);
            relay.stdout!.removeListener('close', onClose);
          };

          relay.stdout!.on('data', onData);
          relay.stdout!.on('close', onClose);
        });
      };

      const sendRelay = (msg: Record<string, unknown>) => {
        relay.stdin!.write(JSON.stringify(msg) + '\n');
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- relay protocol payload shape not modeled client-side
      const readRelay = async (): Promise<any> => {
        const line = await readLine();
        try {
          return JSON.parse(line);
        } catch {
          return { ok: false, detail: `Invalid relay output: ${line.slice(0, 200)}` };
        }
      };

      // ── Step 1: Create run via API ─────────────────────
      const startSpinner = ui.spinner('Creating mobile verification run...');
      let runId: string;
      let goal: string;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mobile-start response shape not modeled client-side
        const res = await api.post<any>(`/api/v1/workspaces/${workspaceId}/mcp/mobile-start`, {
          goal: options['goal'],
          platform: options['platform'],
        });
        runId = res.data.run_id;
        goal = res.data.goal;
        startSpinner.succeed(`Run ${runId} started`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
      } catch (err: any) {
        startSpinner.fail(`Failed to create run: ${err.message}`);
        relay.kill();
        return;
      }

      // ── Step 2: Start Appium session via relay ─────────
      const deviceSpinner = ui.spinner('Connecting to device...');
      sendRelay({
        cmd: 'start',
        appium_url: options['appiumUrl'] || DEFAULT_APPIUM_URL,
        platform: options['platform'],
        app_path: options['apk'] || options['app'] || null,
        device_name: options['device'] || null,
        platform_version: options['osVersion'] || null,
        app_package: options['package'] || null,
        app_activity: options['activity'] || null,
        start_deep_link: options['deepLink'] || null,
      });

      const startResult = await readRelay();
      if (!startResult.ok) {
        deviceSpinner.fail(`Failed to connect: ${startResult.detail}`);
        relay.kill();
        return;
      }
      deviceSpinner.succeed('Device connected');

      // ── Step 3: Main loop ──────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- step result shape not modeled client-side
      const stepResults: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- step history shape not modeled client-side
      const history: any[] = [];
      let stepIndex = 0;
      let passed = false;
      let errorMessage: string | null = null;

      ui.info(`\nRunning: "${goal.slice(0, 80)}${goal.length > 80 ? '...' : ''}"\n`);

      try {
        for (stepIndex = 0; stepIndex < MAX_STEPS; stepIndex++) {
          // a. Extract screen state
          const stepSpinner = ui.spinner(`Step ${stepIndex + 1}/${MAX_STEPS} — reading screen...`);
          sendRelay({ cmd: 'page_source' });
          const pageResult = await readRelay();

          if (!pageResult.ok) {
            stepSpinner.fail(`Failed to read screen: ${pageResult.detail}`);
            errorMessage = pageResult.detail;
            break;
          }

          // b. Send to backend for decision
          stepSpinner.setText(`Step ${stepIndex + 1}/${MAX_STEPS} — thinking...`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mobile-step response shape not modeled client-side
          const stepRes = await api.post<any>(`/api/v1/workspaces/${workspaceId}/mcp/mobile-step`, {
            run_id: runId,
            xml: pageResult.xml,
            step_index: stepIndex,
            history,
          });

          const decision = stepRes.data.decision;
          const done = stepRes.data.done;

          if (done) {
            stepSpinner.succeed(
              `Step ${stepIndex + 1}: done — ${decision.reasoning || 'goal complete'}`,
            );
            passed = true;
            break;
          }

          // c. Execute decision on device
          stepSpinner.setText(
            `Step ${stepIndex + 1}/${MAX_STEPS} — ${decision.tool} ${decision.ref || ''}`,
          );
          sendRelay({ cmd: 'execute', decision });
          const execResult = await readRelay();

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- step entry combines decision + relay result, no shared shape modeled
          const stepEntry: any = {
            step_index: stepIndex,
            decision,
            result: {
              outcome: execResult.ok ? 'success' : 'failure',
              detail: execResult.detail || '',
              duration_ms: execResult.duration_ms || 0,
            },
          };

          stepResults.push(stepEntry);
          history.push(stepEntry);

          if (execResult.ok) {
            stepSpinner.succeed(
              `Step ${stepIndex + 1}: ${decision.tool} ${decision.ref || decision.text || ''}`,
            );
          } else {
            stepSpinner.warn(
              `Step ${stepIndex + 1}: ${decision.tool} failed — ${execResult.detail?.slice(0, 80)}`,
            );
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios/relay error shape not modeled client-side
      } catch (err: any) {
        errorMessage = `${err.message}`;
      }

      if (!passed && !errorMessage && stepIndex >= MAX_STEPS) {
        errorMessage = `Exceeded max steps (${MAX_STEPS}) without completing the goal`;
      }

      // ── Step 4: Report final result ────────────────────
      const reportSpinner = ui.spinner('Reporting results...');
      const status = passed ? 'PASSED' : 'FAILED';
      const title = passed
        ? 'Verification passed'
        : errorMessage?.slice(0, 100) || 'Verification failed';

      try {
        await api.patch(`/api/v1/workspaces/${workspaceId}/mcp/mobile-result/${runId}`, {
          status,
          steps_completed: stepResults.length,
          step_results: stepResults,
          error_message: errorMessage,
          summary_title: title,
          summary: errorMessage || `Completed ${stepResults.length} steps successfully`,
        });
        reportSpinner.succeed('Results reported');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
      } catch (err: any) {
        reportSpinner.fail(`Failed to report: ${err.message}`);
      }

      // ── Cleanup ────────────────────────────────────────
      sendRelay({ cmd: 'quit' });
      try {
        await readRelay();
      } catch {} // wait for quit ack
      relay.kill();

      // ── Print summary ──────────────────────────────────
      ui.info('');
      if (passed) {
        ui.info(`✅ PASSED — ${stepResults.length} step(s)`);
      } else {
        ui.info(`❌ FAILED — ${stepResults.length} step(s) completed`);
        if (errorMessage) ui.error(`Error: ${errorMessage}`);
      }
    });
}

function findRelayPath(): string | null {
  const envPath = process.env.TRACEBACK_BACKEND_PATH;
  if (envPath) {
    const p = path.join(envPath, 'scripts', 'mobile_relay.py');
    if (existsSync(p)) return p;
  }

  const sibling = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    '..',
    '..',
    '..',
    'backend',
    'scripts',
    'mobile_relay.py',
  );
  if (existsSync(sibling)) return sibling;

  const home = path.join(
    os.homedir(),
    'Documents',
    'GitHub',
    'backend',
    'scripts',
    'mobile_relay.py',
  );
  if (existsSync(home)) return home;

  return null;
}
