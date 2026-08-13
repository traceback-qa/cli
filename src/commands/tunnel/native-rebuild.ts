/**
 * Native rebuild runner — the "live update" for frameworks with no hot reload.
 *
 * RN/Flutter update the running app in place (Metro / Dart VM service). Native
 * Swift and Kotlin apps have no such primitive: a change is a full
 *   rebuild → install → relaunch
 * cycle. This module performs that cycle on the local machine (the same one the
 * relay agent runs on, so the device it drives is the device that gets rebuilt),
 * and returns a result the CLI reports to the backend via a `rebuild_done` frame.
 *
 * iOS:    xcodebuild -project <proj> -scheme <scheme> -destination 'platform=iOS
 *         Simulator,id=<udid>' build → locate the built .app in DerivedData →
 *         simctl install <udid> <app> → simctl launch <udid> <bundle-id>.
 * Kotlin: ./gradlew installDebug (installs to the attached adb device) →
 *         adb shell am start -n <package>/<activity>.
 *
 * Both commands are streamed line-by-line to the terminal; failures surface the
 * tail of the build log. A `--dry-run` mode fakes the build so the tunnel wiring
 * can be exercised without a real project.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { detectBootedSimulator, resolveSimctlPath } from '../../infrastructure/mobile/simctl.js';

const execFileP = promisify(execFile);

export interface NativeRebuildOptions {
  /** 'ios' builds with xcodebuild; anything else (e.g. 'kotlin') builds with gradlew. */
  framework: string;
  /** Xcode project (.xcodeproj or .xcworkspace) — iOS only. */
  project?: string;
  /** Xcode scheme — iOS only. */
  scheme?: string;
  /** Target bundle id to launch — iOS only. */
  bundleId?: string;
  /** Device UDID — iOS only (defaults to the booted simulator). */
  udid?: string;
  /** Root of the gradle project (where build.gradle lives) — kotlin only. */
  projectDir?: string;
  /** Android applicationId (e.g. com.example.app) — kotlin only. */
  packageName?: string;
  /** Android activity to launch, e.g. .MainActivity — kotlin only. */
  activity?: string;
  /** Run the commands against real toolchains? false = fake a successful build. */
  dryRun?: boolean;
  /** Live line printer for streaming build output. */
  onLine?: (line: string) => void;
}

export interface NativeRebuildResult {
  status: 'built' | 'failed';
  framework: string;
  message: string;
  startedAt: string;
  durationMs?: number;
}

/**
 * Rebuild → install → relaunch the native app on the attached device.
 * Never throws: every failure is returned as `{ status: 'failed', message }`
 * so the caller can report it through the tunnel instead of crashing.
 */
export async function runNativeRebuild(options: NativeRebuildOptions): Promise<NativeRebuildResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const framework = options.framework === 'ios' ? 'ios' : 'kotlin';

  try {
    const message =
      framework === 'ios'
        ? await rebuildIos(options)
        : await rebuildKotlin(options);
    return {
      status: 'built',
      framework,
      message,
      startedAt,
      durationMs: Date.now() - startedMs,
    };
  } catch (err) {
    return {
      status: 'failed',
      framework,
      message: err instanceof Error ? err.message : String(err),
      startedAt,
      durationMs: Date.now() - startedMs,
    };
  }
}

// ── iOS ───────────────────────────────────────────────────────────────

async function rebuildIos(options: NativeRebuildOptions): Promise<string> {
  const project = options.project;
  const scheme = options.scheme;
  if (!project || !scheme) {
    throw new Error(
      'iOS rebuild needs --project <path.xcodeproj> and --scheme <name>. ' +
        'e.g. traceback tunnel rebuild -f ios --project ios/App.xcodeproj --scheme App --bundle-id com.example.app',
    );
  }

  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    options.onLine?.(line);
  };

  if (options.dryRun) {
    emit(`[dry-run] xcodebuild -project ${project} -scheme ${scheme}`);
    emit('[dry-run] simctl install + launch');
    return `[dry-run] iOS build finished for ${scheme}`;
  }

  const udid = options.udid ?? (await detectBootedSimulator());
  if (!udid) {
    throw new Error('No booted iOS Simulator found — open one, or pass --udid <device-id>.');
  }

  // 1. Build.
  emit(`Building ${scheme} for ${udid}...`);
  try {
    await runStreamed(
      ['-project', project, '-scheme', scheme, '-destination', `platform=iOS Simulator,id=${udid}`, 'build'],
      emit,
    );
  } catch (err) {
    throw new Error(`xcodebuild failed — ${tail(lines)}`);
  }

  // 2. Locate the built .app inside DerivedData. The standard layout puts it under
  // DerivedData/<Project>-*/Build/Products/Debug-iphonesimulator/*.app.
  const appPath = await findBuiltApp(project, scheme);
  if (!appPath) {
    throw new Error(`Could not locate the built .app for ${scheme} in DerivedData`);
  }

  // 3. Install + relaunch.
  const simctl = await resolveSimctlPath();
  if (!simctl) {
    throw new Error('simctl not found (Xcode not installed?)');
  }
  emit(`Installing ${path.basename(appPath)} on ${udid}...`);
  await execFileP(simctl, ['install', udid, appPath], { maxBuffer: 16 * 1024 * 1024 });

  const bundleId = options.bundleId ?? (await appBundleId(appPath));
  emit(`Launching ${bundleId}...`);
  await execFileP(simctl, ['launch', udid, bundleId], { maxBuffer: 16 * 1024 * 1024 });

  return `iOS build installed & launched: ${bundleId} on ${udid}`;
}

/** Locate the built .app under DerivedData for a project/scheme. */
async function findBuiltApp(
  project: string,
  scheme: string,
): Promise<string | null> {
  // Ask xcodebuild where DerivedData is, then scan the product directory.
  try {
    const { stdout } = await execFileP(
      'xcodebuild',
      ['-project', project, '-scheme', scheme, '-showBuildSettings'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const ddMatch = /BUILT_PRODUCTS_DIR = (\S+)/.exec(stdout);
    const productsDir = ddMatch?.[1];
    if (productsDir && existsSync(productsDir)) {
      const apps = (await import('node:fs'))
        .readdirSync(productsDir)
        .filter((f) => f.endsWith('.app'));
      if (apps.length > 0) {
        return path.join(productsDir, apps[0]!);
      }
    }
  } catch {
    /* fall through to the layout heuristic */
  }

  const projectName = path.basename(project).replace(/\.(xcodeproj|xcworkspace)$/, '');
  const candidates = [
    path.join(process.env.HOME ?? '', 'Library', 'Developer', 'Xcode', 'DerivedData'),
  ];
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    for (const entry of (await import('node:fs')).readdirSync(root)) {
      if (!entry.startsWith(projectName)) continue;
      const productRoot = path.join(
        root,
        entry,
        'Build',
        'Products',
        `Debug-iphonesimulator`,
      );
      if (!existsSync(productRoot)) continue;
      const apps = (await import('node:fs')).readdirSync(productRoot).filter((f) => f.endsWith('.app'));
      if (apps.length > 0) return path.join(productRoot, apps[0]!);
    }
  }
  return null;
}

/** Read CFBundleIdentifier from a built .app's Info.plist. */
async function appBundleId(appPath: string): Promise<string> {
  const plistPath = path.join(appPath, 'Info.plist');
  try {
    const { stdout } = await execFileP('/usr/libexec/PlistBuddy', [
      '-c',
      'Print CFBundleIdentifier',
      plistPath,
    ]);
    const id = stdout.trim();
    if (id) return id;
  } catch {
    /* fall through */
  }
  throw new Error('Could not read CFBundleIdentifier from the built app — pass --bundle-id');
}

// ── Kotlin / Android ──────────────────────────────────────────────────

async function rebuildKotlin(options: NativeRebuildOptions): Promise<string> {
  const projectDir = options.projectDir ?? '.';
  const packageName = options.packageName;
  if (!packageName) {
    throw new Error(
      'Kotlin rebuild needs --package <applicationId> (e.g. com.example.app). ' +
        'traceback tunnel rebuild -f kotlin --project-dir android --package com.example.app',
    );
  }

  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    options.onLine?.(line);
  };

  if (options.dryRun) {
    const gradlew = path.join(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    emit(`[dry-run] ${gradlew} installDebug`);
    emit(`[dry-run] adb shell am start -n ${packageName}/${options.activity ?? '.MainActivity'}`);
    return `[dry-run] Kotlin build installed for ${packageName}`;
  }

  const gradlew = path.join(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(gradlew)) {
    throw new Error(
      `No gradlew in ${projectDir}. Run from the Android project root or pass --project-dir <dir>.`,
    );
  }

  // 1. Build + install on the attached device.
  emit('Building & installing (gradlew installDebug)...');
  try {
    await runStreamed(['installDebug'], emit, { cwd: projectDir, cmd: gradlew });
  } catch (err) {
    throw new Error(`gradlew installDebug failed — ${tail(lines)}`);
  }

  // 2. Relaunch the app.
  const adb = await resolveAdbPath();
  const activity = options.activity ?? '.MainActivity';
  emit(`Launching ${packageName}/${activity}...`);
  await execFileP(adb, ['shell', 'am', 'start', '-n', `${packageName}/${activity}`], {
    maxBuffer: 4 * 1024 * 1024,
  });

  return `Kotlin build installed & launched: ${packageName}/${activity}`;
}

// ── Shared ────────────────────────────────────────────────────────────

/** Stream a command's stdout+stderr line-by-line; rejects with the exit code. */
async function runStreamed(
  args: string[],
  onLine: (line: string) => void,
  opts: { cwd?: string; cmd?: string } = {},
): Promise<void> {
  const { spawn } = await import('node:child_process');
  const cmd = opts.cmd ?? 'xcodebuild';
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const feed = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) onLine(line);
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exited with code ${code}`));
    });
  });
}

function tail(lines: string[], n = 20): string {
  return lines.slice(-n).join('\n');
}

/** Absolute path to adb, defaulting to ANDROID_HOME/platform-tools/adb. */
export async function resolveAdbPath(): Promise<string> {
  const { existsSync } = await import('node:fs');
  const candidates = [
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : '',
    process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : '',
    path.join(process.env.HOME ?? '', 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    '/usr/local/bin/adb',
    '/opt/homebrew/bin/adb',
  ].filter(Boolean);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('adb not found — set ANDROID_HOME or add adb to PATH');
  return found;
}
