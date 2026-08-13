/**
 * `traceback mobile dev` / `traceback mobile test` — Mode 1: a persistent cloud emulator with
 * a live-reload tunnel, instead of the provision/install/test/teardown cycle `mobile verify`
 * (and every queue-dispatched run) pays every single time.
 *
 * `mobile dev` starts the session over the CUSTOM RELAY TUNNEL (no ngrok, no `expo start
 * --tunnel`): it creates a relay session, attaches this machine as the relay agent (the same
 * mechanism `traceback tunnel up` uses), and records the session's public URL as the bundler
 * URL — the provisioned cloud device reaches the local Metro/Expo dev server through the
 * tunnel instead of through a third-party tunnel service. `--tunnel-url` remains as a legacy
 * escape hatch that preserves the old external-Expo-tunnel behavior.
 *
 * Flutter (Topology A) works differently and is handled by this same command: there is no
 * Metro to tunnel — the app is a compiled debug APK the BACKEND installs on the cloud
 * emulator, and hot reload rides the Dart VM service. So for Flutter the CLI builds the APK
 * locally (the user's machine owns the source + Flutter SDK), uploads it, asks the backend to
 * boot + install + launch, then wires `flutter attach` through the tunnel's VM-service bridge
 * (see assets/flutter/flutter-vmshim.mjs): the shim exposes `ws://127.0.0.1:9001` and pumps
 * bytes to the cloud app's VM service, so pressing `r` in attach hot-reloads the cloud
 * emulator.
 *
 * `mobile test` runs one goal against whatever session is currently live for the workspace and
 * prints a link to the *existing* run-viewer page (`/runs/initializing?session_id=...`) — a
 * Mode-1 test still creates a real `TestRun` row server-side, so nothing new was needed on the
 * frontend for this to just work.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { CliContext } from '../../types/context.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';
import { RelayAgentClient, type RelayReadyInfo } from '../../infrastructure/tunnel/relay/index.js';

type ContextGetter = (cmd: Command) => CliContext | undefined;

// Metro's own status endpoint — `GET /status` on the bundler port replies "packager-status:running"
// when a dev server is already up. Default RN/Expo port; not configurable via a flag here since
// neither RN nor Expo commonly runs it anywhere else.
const METRO_STATUS_URL = 'http://localhost:8081/status';

// The local VM-service shim exposes flutter attach here (see assets/flutter/flutter-vmshim.mjs).
const FLUTTER_SHIM_PORT = 9001;

async function isMetroRunning(): Promise<boolean> {
  try {
    const res = await fetch(METRO_STATUS_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve the workspace id the same way `traceback workspaces` persists it — NOT the broken
 * `ctx.activeWorkspaceId` cast `mobile verify` uses (dead code, no such field on CliContext). */
async function resolveWorkspaceId(
  ctx: CliContext,
  explicit: string | undefined,
): Promise<string | null> {
  if (explicit) return explicit;
  const config = await ctx.infra.config.loadGlobalConfig();
  return config.workspaceId ?? null;
}

async function getAuthToken(ctx: CliContext): Promise<string | null> {
  const token = await ctx.infra.authStore.get();
  return token?.accessToken ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Detect the project's mobile framework (+ Expo SDK) from the cwd.
 *
 * A Flutter project is detected from `pubspec.yaml` (`sdk: flutter` dependency) and needs a
 * completely different dev loop (debug APK + Dart VM service, no Metro). Otherwise package.json
 * decides: expo (install Expo Go on the cloud emulator) vs react-native (dev build). Fallback
 * is 'expo' — the most common `mobile dev` case, and the backend's default. */
export async function detectFramework(
  cwd: string,
): Promise<{ framework: string; sdkVersion?: string }> {
  try {
    const pubspec = await readFile(path.join(cwd, 'pubspec.yaml'), 'utf8');
    if (/\bsdk:\s*flutter\b/.test(pubspec)) {
      return { framework: 'flutter' };
    }
  } catch {
    // no readable pubspec.yaml — not a Flutter project
  }
  try {
    const raw = await readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = {
      ...((pkg.dependencies ?? {}) as Record<string, unknown>),
      ...((pkg.devDependencies ?? {}) as Record<string, unknown>),
    };
    const expoVersion = deps['expo'];
    if (typeof expoVersion === 'string') {
      const major = expoVersion.replace(/^[~^]/, '').split('.')[0];
      if (major) return { framework: 'expo', sdkVersion: major };
      return { framework: 'expo' };
    }
    if (deps['react-native']) return { framework: 'react-native' };
  } catch {
    // no readable package.json — fall through to the default
  }
  return { framework: 'expo' };
}

/** Resolve the Flutter app id (applicationId / namespace) from the Android Gradle files —
 * best-effort; the backend falls back to `aapt dump badging` when this returns undefined. */
export async function detectFlutterPackage(cwd: string): Promise<string | undefined> {
  for (const file of ['android/app/build.gradle.kts', 'android/app/build.gradle']) {
    try {
      const text = await readFile(path.join(cwd, file), 'utf8');
      const match =
        text.match(/namespace\s*=\s*["']([^"']+)["']/) ??
        text.match(/applicationId\s+["']([^"']+)["']/) ??
        text.match(/namespace\s+["']([^"']+)["']/);
      if (match) return match[1];
    } catch {
      // try the next candidate file
    }
  }
  return undefined;
}

/** Locate the VM-service shim script. Ships next to the bundle (tsup publicDir) and also
 * lives in the repo checkout — resolved via import.meta.url with a TRACEBACK_FLUTTER_SHIM
 * env override for exotic installs. */
export function flutterShimPath(): string | null {
  const candidates = [
    process.env['TRACEBACK_FLUTTER_SHIM'],
    fileURLToPath(new URL('./flutter-vmshim.mjs', import.meta.url)),
    path.join(process.cwd(), '.flutter-vmshim.mjs'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Locate the `adb` binary: PATH first, then common Android SDK install locations. */
export function resolveAdbPath(homedir: string = os.homedir()): string | null {
  const candidates = [
    'adb',
    ...(process.env['ANDROID_HOME']
      ? [path.join(process.env['ANDROID_HOME'], 'platform-tools', 'adb')]
      : []),
    ...(process.env['ANDROID_SDK_ROOT']
      ? [path.join(process.env['ANDROID_SDK_ROOT'], 'platform-tools', 'adb')]
      : []),
    path.join(homedir, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    path.join(homedir, 'Android', 'Sdk', 'platform-tools', 'adb'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate === 'adb') {
        const probe = spawnSync('adb', ['version'], { stdio: 'ignore' });
        if (probe.status === 0) return 'adb';
        continue;
      }
      if (existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Resolve the serial of the first online adb device, so multi-device setups don't make
 * `adb reverse` fail with "more than one device/emulator". Returns null when ambiguous. */
export function resolveAdbSerial(adb: string): string | null {
  try {
    const res = spawnSync(adb, ['devices'], { timeout: 5_000, encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) return null;
    for (const line of res.stdout.split('\n').slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state === 'device') return serial;
    }
  } catch {
    // adb may be gone between resolution and use — treat as ambiguous
  }
  return null;
}

/** Make the device's <port> loop back to this host's <port> so `flutter attach` reaches the shim.
 *
 * `flutter attach --debug-url ws://127.0.0.1:<port>/ws` treats the URL port as the DEVICE-side
 * port: it runs `adb forward tcp:<random> tcp:<port>` and connects to the forwarded host port.
 * Without a matching `adb reverse tcp:<port> tcp:<port>`, that forward lands on a dead device
 * port and attach dies with "Connection closed before full header was received" (the bug that
 * plagued the first live Flutter tunnel runs). With the reverse, the chain is:
 * attach → adb forward → device:<port> → adb reverse → host:<port> (the VM-service shim) →
 * tunnel → cloud emulator's Dart VM service.
 *
 * Best-effort: no adb / no device → false, and the caller decides how loudly to complain. */
export async function setupFlutterAdbReverse(port: number): Promise<boolean> {
  const adb = resolveAdbPath();
  if (!adb) return false;
  const serial = resolveAdbSerial(adb);
  const args = serial ? ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`] : ['reverse', `tcp:${port}`, `tcp:${port}`];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = spawnSync(adb, args, { timeout: 10_000, encoding: 'utf8' });
      if (res.status === 0) return true;
    } catch {
      // device may not be online yet — retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/** Run `flutter build apk --debug` in the project; returns the APK path, or null with a log
 * tail on failure. The user's machine owns the Flutter SDK + source, so the CLI builds and the
 * backend installs — the cloud never sees the user's code. */
async function buildFlutterApk(cwd: string): Promise<{ apkPath: string; log: string } | null> {
  return await new Promise((resolve) => {
    const child = spawn('flutter', ['build', 'apk', '--debug'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ apkPath: '', log: `${log}\n${err.message}` });
    });
    child.on('close', (code) => {
      const apkPath = path.join(cwd, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk');
      if (code === 0 && existsSync(apkPath)) {
        resolve({ apkPath, log });
      } else {
        resolve({ apkPath: '', log });
      }
    });
  });
}

/** Spawn the VM-service shim + `flutter attach`, wired to THIS session's tunnel.
 *
 * The shim reads its session config from temp files the backend's launch-device response
 * just produced, connects to the backend's /relay/s/<code>/vm/... bridge (which pipes to the
 * cloud emulator's Dart VM service), and exposes ws://127.0.0.1:9001 locally. `flutter attach
 * --debug-url` then hot-reloads the cloud app — press `r` (reload) or `R` (restart). Both
 * children are tracked for cleanup when the session stops. */
function spawnFlutterDevLoop(opts: {
  shimPath: string;
  apiUrl: string;
  deviceToken: string;
  code: string;
  vmPath: string;
  cwd: string;
  onSpawnError: (label: string, message: string) => void;
}): { shim: ReturnType<typeof spawn>; attach: ReturnType<typeof spawn> | null } {
  const sessionFile = path.join(os.tmpdir(), 'relay_session_flutter.json');
  const vmPathFile = path.join(os.tmpdir(), 'vm_service_path.txt');
  void writeFile(sessionFile, JSON.stringify({ code: opts.code, device_token: opts.deviceToken }));
  void writeFile(vmPathFile, opts.vmPath);

  const apiUrl = new URL(opts.apiUrl);
  const holder: {
    shim: ReturnType<typeof spawn>;
    attach: ReturnType<typeof spawn> | null;
  } = {
    shim: spawn(process.execPath, [opts.shimPath], {
      env: {
        ...process.env,
        RELAY_API_HOST: apiUrl.hostname,
        RELAY_API_PORT: apiUrl.port || '80',
        RELAY_VM_MODE: '1',
        RELAY_SESSION_FILE: sessionFile,
        RELAY_VM_PATH_FILE: vmPathFile,
        SHIM_PORT: String(FLUTTER_SHIM_PORT),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    }),
    attach: null,
  };
  holder.shim.on('error', (err) => {
    opts.onSpawnError('VM-service shim', err.message);
  });
  // flutter attach adb-forwards to the device-side port (see setupFlutterAdbReverse): the
  // device's port must loop back to this host's shim, or attach connects to a dead port.
  // Kick the reverse off now (it retries while the device finishes booting) and AWAIT it
  // before attach spawns so attach never races a not-yet-set reverse.
  const reversePromise = setupFlutterAdbReverse(FLUTTER_SHIM_PORT);
  // Give the shim a moment to bind :9001 before attach tries to connect.
  setTimeout(async () => {
    if (holder.shim.killed) return;
    const reverseOk = await reversePromise;
    if (!reverseOk && !holder.shim.killed) {
      opts.onSpawnError(
        'adb reverse',
        `device:${FLUTTER_SHIM_PORT} -> host shim loopback failed - flutter attach may not connect`,
      );
    }
    if (holder.shim.killed) return;
    holder.attach = spawn(
      'flutter',
      ['attach', '--debug-url', `ws://127.0.0.1:${FLUTTER_SHIM_PORT}/ws`],
      { cwd: opts.cwd, stdio: 'inherit' },
    );
    holder.attach.on('error', (err) => {
      opts.onSpawnError('flutter attach', err.message);
    });
  }, 1500);
  return holder;
}

export function registerMobileDevCommands(mobile: Command, getContext: ContextGetter): void {
  mobile
    .command('dev')
    .description(
      'Start a persistent cloud emulator with a live-reload tunnel to your local dev server —\n' +
        'the device stays up across every `mobile test` call instead of a fresh\n' +
        'provision+install per run. Uses the custom relay tunnel (no ngrok, no expo --tunnel).\n' +
        'Expo/RN hot-reloads from your local Metro; Flutter builds the debug APK, uploads it,\n' +
        'and wires `flutter attach` through the tunnel (press r to hot reload).\n' +
        'Ctrl+C to stop and release the device.',
    )
    .option('-a, --app <buildName>', 'Mobile build name to install (from Toolbox)')
    .option('--workspace <id>', 'Workspace ID (defaults to current)')
    .option(
      '--no-device',
      "Don't boot a cloud emulator — tunnel only. Use when the app already runs on a " +
        'device you control (e.g. your own emulator driven via Appium).',
    )
    .option(
      '--tunnel-url <url>',
      'Legacy: reuse an already-running Expo tunnel URL instead of the relay tunnel',
    )
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;
      await createRequireAuthMiddleware(ctx)();

      const { api, ui } = ctx.infra;
      // Commander's `--no-device` flag surfaces as `options.device === false`
      // (the option is named `device`, defaulting to true).
      const noDevice = options['device'] === false;
      const workspaceId = await resolveWorkspaceId(ctx, options['workspace']);
      if (!workspaceId) {
        ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
        return;
      }
      // Detected once, used everywhere: the session's framework label and the
      // Expo SDK the backend needs to resolve the Expo Go APK.
      const { framework, sdkVersion } = await detectFramework(process.cwd());
      const isFlutter = framework === 'flutter';

      let relayClient: RelayAgentClient | null = null;
      let bundlerUrl: string | undefined;
      let sessionUrl: string | null = null;
      let sessionId: string | null = null;
      let deviceToken: string | null = null;
      let code: string | null = null;
      let streamUrl: string | null = null;
      let flutterLoop: { shim: ReturnType<typeof spawn>; attach: ReturnType<typeof spawn> | null } | null =
        null;

      // New default path: the custom relay tunnel — no ngrok, no `expo start --tunnel`.
      // For Expo/RN, Metro is expected to already run on :8081; we create the relay session
      // first, attach this machine as the agent, then pass the session's public URL to the
      // backend as the bundler URL so the provisioned cloud device loads the app over the
      // tunnel. Flutter skips the agent entirely (no Metro): the app is an installed APK and
      // hot reload rides the VM-service bridge, so there is nothing to attach.
      if (options['tunnelUrl'] === undefined) {
        if (!isFlutter && !(await isMetroRunning())) {
          ui.warn(
            'No local Metro/Expo dev server found on :8081. Start one first (e.g. `npx expo start`),\n' +
              'then re-run this command.',
          );
          return;
        }

        const createSpinner = ui.spinner('Creating the relay session...');
        try {
          const res = await api.post<{
            session_id?: string;
            session_url?: string | null;
            proxy_path?: string | null;
            device_token?: string | null;
            stream_url?: string | null;
            error?: string;
          }>(`/api/v1/workspaces/${workspaceId}/mobile-sessions`, {
            mobile_app_id: options['app'],
            framework,
          });
          if (res.data.error || !res.data.session_id) {
            createSpinner.fail(`Failed to start session: ${res.data.error ?? 'unknown error'}`);
            return;
          }
          sessionId = res.data.session_id;
          sessionUrl = res.data.session_url ?? null;
          deviceToken = res.data.device_token ?? null;
          streamUrl = res.data.stream_url ?? null;
          code = res.data.proxy_path?.split('/').pop() ?? null;
          createSpinner.succeed('Relay session created');
          if (ui.isJsonMode()) {
            // Machine-readable bootstrap: emit the session info the moment the session
            // exists, so the MCP server can grab the session_id and start verifying
            // while this command keeps the tunnel alive in the foreground.
            ui.renderJson({
              event: 'session',
              session_id: sessionId,
              session_url: sessionUrl,
              stream_url: streamUrl,
            });
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
        } catch (err: any) {
          createSpinner.fail(`Failed to start session: ${err.message}`);
          return;
        }

        // Flutter has no relay agent, so the `ready` event (which the MCP waits for
        // before the `device` event — and for Topology B it waits for `ready` alone)
        // is emitted as soon as the session exists. The session IS usable from this
        // point; the device boot follows.
        if (isFlutter && ui.isJsonMode()) {
          ui.renderJson({
            event: 'ready',
            session_id: sessionId,
            session_url: sessionUrl,
            stream_url: streamUrl,
            code,
          });
        }

        if (!isFlutter) {
          const authToken = await getAuthToken(ctx);
          if (!authToken) {
            ui.error('No auth token found — run `traceback login` first.');
            return;
          }
          const config = await ctx.infra.config.loadGlobalConfig();
          const attachSpinner = ui.spinner('Attaching the local dev server to the relay...');
          try {
            relayClient = new RelayAgentClient({
              apiUrl: config.apiUrl,
              authToken,
              sessionId,
              localUrl: 'http://localhost:8081',
              localWsUrl: 'ws://localhost:8081',
              logger: {
                debug: (message) => ui.debug(message),
                warn: (message) => ui.debug(message),
              },
              onReady: (info: RelayReadyInfo) => {
                attachSpinner.succeed('Tunnel live');
                bundlerUrl = sessionUrl ?? undefined;
                if (ui.isJsonMode()) {
                  // The tunnel is now attached: the session's public URL forwards to the
                  // local dev server, so the MCP server can register the device and start
                  // verifying. Emit the ready event as the final stdout line.
                  ui.renderJson({
                    event: 'ready',
                    session_id: info.sessionId,
                    session_url: sessionUrl,
                    stream_url: streamUrl,
                    code: info.code ?? null,
                  });
                } else {
                  ui.info('');
                  ui.info(`Session ${info.sessionId} is live. Save a file — changes should appear in ~2s.`);
                  if (sessionUrl) ui.info(`Bundle URL (tunnel): ${sessionUrl}`);
                  if (streamUrl) ui.info(`Watch it: ${streamUrl}`);
                  ui.info('Run tests against it from another terminal with:');
                  ui.info(`  traceback mobile test -g "<goal>" --workspace ${workspaceId}`);
                  ui.info('\nPress Ctrl+C to stop.\n');
                }
              },
            });
            await relayClient.connect();
          } catch (err) {
            attachSpinner.fail(`Failed to attach: ${errorMessage(err)}`);
            // Don't leak the just-created session (it would block the workspace's active
            // session slot until idle-timeout).
            if (sessionId) {
              await api
                .delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`)
                .catch(() => {});
            }
            return;
          }
        }
      } else {
        // Legacy path: reuse an external Expo tunnel URL as before.
        bundlerUrl = options['tunnelUrl'];
      }

      // Topology A: the BACKEND boots the cloud emulator and opens the app through
      // the tunnel. Skipped with --no-device (the device is on the user's side —
      // e.g. their own emulator driven via Appium through this same tunnel).
      if (!noDevice && sessionId) {
        // ── Flutter: build the APK locally, upload it, then launch ──────────────
        if (isFlutter) {
          const buildSpinner = ui.spinner('Building the Flutter debug APK (first build can take minutes)...');
          const built = await buildFlutterApk(process.cwd());
          if (!built?.apkPath) {
            buildSpinner.fail('Flutter build failed');
            ui.error((built?.log ?? 'no output').slice(-2000));
            await api
              .delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`)
              .catch(() => {});
            return;
          }
          buildSpinner.succeed('Flutter debug APK built');

          const uploadSpinner = ui.spinner('Uploading the APK to the backend...');
          try {
            const apkBuffer = await readFile(built.apkPath);
            await api.put<{ status?: string; error?: string }>(
              `/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}/apk`,
              apkBuffer,
              {
                timeout: 600_000,
                retryAttempts: 0,
                headers: { 'Content-Type': 'application/octet-stream' },
              },
            );
            uploadSpinner.succeed(`APK uploaded (${(apkBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
          } catch (err: any) {
            uploadSpinner.fail(`APK upload failed: ${err.message}`);
            await api
              .delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`)
              .catch(() => {});
            return;
          }
        }

        const deviceSpinner = ui.spinner('Booting the cloud emulator and loading your app...');
        try {
          // Boot + install can take minutes (a first-time AVD creation even
          // longer — system image download) — well past the 30s default timeout,
          // and a late 5xx must NOT auto-retry (that would boot twice).
          const res = await api.post<{
            session_id?: string;
            status?: string;
            udid?: string | null;
            app_url?: string | null;
            framework?: string | null;
            vm_service?: { host_port?: number; path?: string } | null;
            expo_go_installed?: boolean;
            already_running?: boolean;
            error?: string;
          }>(
            `/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}/launch-device`,
            {
              framework,
              sdk_version: sdkVersion,
              package: isFlutter ? await detectFlutterPackage(process.cwd()) : undefined,
            },
            { timeout: 600_000, retryAttempts: 0 },
          );
          if (res.data.error || !res.data.session_id) {
            deviceSpinner.warn(`Device launch failed: ${res.data.error ?? 'unknown error'}`);
          } else {
            deviceSpinner.succeed('Cloud emulator ready — your app is loading through the tunnel');
            const vmService = res.data.vm_service ?? null;
            if (ui.isJsonMode()) {
              // Machine-readable: the device is up and the app URL is open on it, so
              // the MCP server can start verifying against the session's device.
              ui.renderJson({
                event: 'device',
                session_id: sessionId,
                status: res.data.status ?? 'ready',
                udid: res.data.udid ?? null,
                app_url: res.data.app_url ?? null,
                framework: res.data.framework ?? framework,
                vm_service: vmService,
                expo_go_installed: res.data.expo_go_installed ?? false,
                already_running: res.data.already_running ?? false,
              });
            } else {
              if (res.data.app_url) ui.info(`App URL (on the emulator): ${res.data.app_url}`);
              if (res.data.expo_go_installed) ui.info('Expo Go: ready');
              if (isFlutter) {
                if (vmService?.path && deviceToken && code) {
                  const shimPath = flutterShimPath();
                  if (shimPath) {
                    const config = await ctx.infra.config.loadGlobalConfig();
                    flutterLoop = spawnFlutterDevLoop({
                      shimPath,
                      apiUrl: config.apiUrl,
                      deviceToken,
                      code,
                      vmPath: vmService.path,
                      cwd: process.cwd(),
                      onSpawnError: (label, message) =>
                        ui.warn(`${label} failed to start: ${message}`),
                    });
                    ui.info('');
                    ui.info('Flutter attach is wired through the tunnel — press r to hot reload,');
                    ui.info('R to hot restart. Edits land on the cloud emulator in ~1-3s.');
                    ui.info('\nPress Ctrl+C to stop.\n');
                  } else {
                    ui.warn('VM-service shim not found — hot reload unavailable (set TRACEBACK_FLUTTER_SHIM).');
                  }
                } else {
                  ui.warn('VM service not ready on the session — hot reload unavailable for this launch.');
                }
              }
              ui.info('Edit a file — changes hot-reload on the emulator in ~2s.');
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
        } catch (err: any) {
          // Not fatal: the tunnel stays up and the session is usable; the device can
          // be launched manually later (or via Appium for a user-owned device). But
          // a JSON consumer waiting on the `device` event must hear about it — a
          // silent failure would otherwise hang it for its whole timeout.
          deviceSpinner.warn(`Could not launch the cloud emulator automatically: ${err.message}`);
          if (ui.isJsonMode() && sessionId) {
            ui.renderJson({
              event: 'device',
              session_id: sessionId,
              status: 'failed',
              error: err.message,
            });
          }
        }
      } else if (noDevice && ui.isJsonMode() && sessionId) {
        ui.renderJson({ event: 'device', session_id: sessionId, status: 'skipped' });
      }

      const sessionSpinner = ui.spinner('Starting the persistent device session...');
      try {
        if (!sessionId) {
          const res = await api.post<{
            session_id?: string;
            stream_url?: string | null;
            error?: string;
          }>(`/api/v1/workspaces/${workspaceId}/mobile-sessions`, {
            mobile_app_id: options['app'],
            bundler_url: bundlerUrl,
          });
          if (res.data.error || !res.data.session_id) {
            sessionSpinner.fail(`Failed to start session: ${res.data.error ?? 'unknown error'}`);
            return;
          }
          sessionId = res.data.session_id;
          streamUrl = res.data.stream_url ?? null;
        }
        sessionSpinner.succeed('Session live and tunneled');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
      } catch (err: any) {
        sessionSpinner.fail(`Failed to start session: ${err.message}`);
        return;
      }

      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          ui.info('\nStopping...');
          resolve();
        });
      });

      // Tear down the Flutter shim + attach children (attach inherits the terminal, but
      // the shim would otherwise linger as an orphan pumping to a dead session).
      try {
        flutterLoop?.shim.kill();
        flutterLoop?.attach?.kill();
      } catch {
        /* already gone */
      }

      const stopSpinner = ui.spinner('Releasing the device...');
      try {
        await relayClient?.stop();
        await api.delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`);
        stopSpinner.succeed('Device released');
      } catch {
        stopSpinner.warn('Could not confirm the device was released — it will idle-timeout on its own.');
      }
    });

  mobile
    .command('test')
    .description('Run one goal against the currently-live `mobile dev` session.')
    .requiredOption('-g, --goal <text>', 'Natural-language test goal')
    .option('--workspace <id>', 'Workspace ID (defaults to current)')
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;
      await createRequireAuthMiddleware(ctx)();

      const { api, ui } = ctx.infra;
      const workspaceId = await resolveWorkspaceId(ctx, options['workspace']);
      if (!workspaceId) {
        ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
        return;
      }

      const statusSpinner = ui.spinner('Looking for a live session...');
      let sessionId: string;
      try {
        const status = await api.get<{ active: boolean; session_id?: string }>(
          `/api/v1/workspaces/${workspaceId}/mobile-sessions`,
        );
        if (!status.data.active || !status.data.session_id) {
          statusSpinner.fail('No live session — run `traceback mobile dev` first.');
          return;
        }
        sessionId = status.data.session_id;
        statusSpinner.succeed('Found a live session');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
      } catch (err: any) {
        statusSpinner.fail(`Failed to check session status: ${err.message}`);
        return;
      }

      const runSpinner = ui.spinner('Running against the live device...');
      try {
        const res = await api.post<{ run_id?: string; status?: string; error?: string }>(
          `/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}/test`,
          { goal: options['goal'] },
        );
        if (res.data.error || !res.data.run_id) {
          runSpinner.fail(`Run failed: ${res.data.error ?? 'unknown error'}`);
          return;
        }
        runSpinner.succeed(`${res.data.status} — run ${res.data.run_id}`);
        ui.info(
          `View it in your dashboard: Runs > find run_id ${res.data.run_id}\n` +
            '(no direct link here — this CLI has no config for the dashboard\'s own URL yet)',
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
      } catch (err: any) {
        runSpinner.fail(`Run failed: ${err.message}`);
      }
    });
}
