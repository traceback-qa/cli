/**
 * Setup command — installs the local tooling `traceback mobile verify` needs.
 *
 * `traceback mobile` drives a real Android emulator/iOS simulator via Appium
 * (`src/infrastructure/mobile/appium.bridge.ts`, `device.detector.ts`) — none of that ships as a
 * dependency of this package (Appium itself, its two device drivers, and the platform SDKs are
 * all much bigger installs than a CLI should silently drag in), so up to now a first-time user
 * hit "Make sure Appium is running: `appium`" with no way to get there from inside the CLI.
 *
 * What this does and doesn't install:
 *   - Appium itself + the uiautomator2/xcuitest drivers: installed here (`npm install -g`, then
 *     `appium driver install`), since those are just npm packages this CLI can safely run.
 *   - ffmpeg: installed here too — a static build downloaded into the Traceback data dir (no
 *     brew/package manager needed). iOS screen recording encodes with it; Android records
 *     on-device and doesn't need it.
 *   - Android platform-tools (`adb`) / Xcode Command Line Tools (`xcrun`): only detected, never
 *     auto-installed. These are multi-gigabyte, often-interactive installs (Android Studio,
 *     Xcode from the App Store) — the responsible move is pointing at the real installer, not
 *     silently kicking one off.
 *   - WebDriverAgent (iOS only): pre-built here via a real `xcodebuild build-for-testing` — see
 *     wda-prebuild.ts for why. Unlike the installs above this is a build, not a package fetch,
 *     so it's best-effort: Xcode/signing quirks can make it fail on a given machine in ways
 *     `npm install` never does, and a failure here just leaves the first real iOS run to build
 *     it instead (the pre-existing behavior, not a regression).
 */

import type { Command } from 'commander';
import { execSync, spawn } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { getContext as GetContextFn } from '../../cli.js';
import type { UIService } from '../../infrastructure/ui/ui.types.js';
import { getDataDir } from '../../platform/paths.js';
import { xcodeAppInstalled } from '../../infrastructure/mobile/device.detector.js';
import {
  wdaDerivedDataPath,
  wdaIsPrebuilt,
  wdaProjectPath,
} from '../../infrastructure/mobile/wda-prebuild.js';

type ContextGetter = typeof GetContextFn;

const DRIVERS: { name: string; label: string; macOnly: boolean }[] = [
  { name: 'uiautomator2', label: 'Android (uiautomator2)', macOnly: false },
  { name: 'xcuitest', label: 'iOS (xcuitest)', macOnly: true },
];

export function registerSetupCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('setup')
    .description('Install Appium and the drivers needed for `traceback mobile verify`')
    .option('-y, --yes', 'Skip confirmation prompts', false)
    .action(async function (this: Command, options: { yes: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;
      const ui = ctx.infra.ui;

      ui.info('Checking mobile testing dependencies...\n');

      await ensureAppium(ui, options.yes);
      await ensureDrivers(ui, options.yes);
      await ensureFfmpeg(ui, options.yes);
      checkJava(ui);
      checkAndroidSdk(ui);
      checkXcode(ui);
      await ensureWdaPrebuilt(ui, options.yes);

      ui.info('\nDone. Run `traceback doctor` any time to re-check your setup.');
    });
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Run a command with output streamed straight to the terminal (npm/appium installs are slow
 * and users should see real progress, not a silent spinner). Resolves to the exit code. */
async function runStreamed(command: string, args: string[]): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function ensureAppium(ui: UIService, skipConfirm: boolean): Promise<void> {
  if (commandExists('appium')) {
    const version = execSync('appium --version', { encoding: 'utf-8' }).trim();
    ui.success(`Appium already installed (${version})`);
    return;
  }

  ui.warn('Appium is not installed.');
  if (!skipConfirm) {
    const { confirm } = await import('@inquirer/prompts');
    const install = await confirm({
      message: 'Install Appium now (npm install -g appium)?',
      default: true,
    });
    if (!install) {
      ui.hint("Skipped. Install it yourself with `npm install -g appium` when you're ready.");
      return;
    }
  }

  ui.info('Installing Appium...');
  const code = await runStreamed('npm', ['install', '-g', 'appium']);
  if (code === 0 && commandExists('appium')) {
    ui.success('Appium installed.');
  } else {
    ui.error('Appium install failed — see the output above.');
    ui.hint('You can retry manually with `npm install -g appium`.');
  }
}

function listInstalledDrivers(): Set<string> {
  try {
    const raw = execSync('appium driver list --json', { encoding: 'utf-8', stdio: 'pipe' });
    const parsed = JSON.parse(raw) as Record<string, { installed?: boolean }>;
    return new Set(
      Object.entries(parsed)
        .filter(([, info]) => info?.installed)
        .map(([name]) => name),
    );
  } catch {
    // Appium missing, or an older/newer CLI with a different `driver list` output shape --
    // either way, fall through and let `appium driver install` itself be the source of truth
    // (it no-ops cleanly if a driver's already there).
    return new Set();
  }
}

async function ensureDrivers(ui: UIService, skipConfirm: boolean): Promise<void> {
  if (!commandExists('appium')) return; // nothing to install drivers into

  const installed = listInstalledDrivers();
  const applicable = DRIVERS.filter((d) => !d.macOnly || process.platform === 'darwin');
  const needed: typeof DRIVERS = [];

  for (const driver of applicable) {
    if (installed.has(driver.name)) {
      ui.success(`Driver already installed: ${driver.label}`);
    } else {
      needed.push(driver);
    }
  }

  if (needed.length === 0) return;

  if (!skipConfirm) {
    const { confirm } = await import('@inquirer/prompts');
    const install = await confirm({
      message: `Install ${needed.length} Appium driver${needed.length > 1 ? 's' : ''} (${needed.map((d) => d.label).join(', ')})?`,
      default: true,
    });
    if (!install) {
      ui.hint('Skipped. Install a driver later with `appium driver install <name>`.');
      return;
    }
  }

  for (const driver of needed) {
    ui.info(`Installing driver: ${driver.label}...`);
    const code = await runStreamed('appium', ['driver', 'install', driver.name]);
    if (code === 0) {
      ui.success(`Driver installed: ${driver.label}`);
    } else {
      ui.error(`Failed to install driver: ${driver.label} — see the output above.`);
    }
  }
}

const FFMPEG_RELEASE_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download';

/** Static ffmpeg release asset for the current platform/arch, or null if none is published. */
function ffmpegAssetName(): string | null {
  const assets: Record<string, string> = {
    'darwin/arm64': 'ffmpeg-darwin-arm64',
    'darwin/x64': 'ffmpeg-darwin-x64',
    'linux/x64': 'ffmpeg-linux-x64',
    'linux/arm64': 'ffmpeg-linux-arm64',
    'win32/x64': 'ffmpeg-win32-x64',
    'win32/ia32': 'ffmpeg-win32-ia32',
  };
  return assets[`${process.platform}/${process.arch}`] ?? null;
}

function ffmpegBinPath(): string {
  return path.join(getDataDir(), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

function printFfmpegPathHint(ui: UIService, binDir: string): void {
  if (process.platform === 'win32') {
    ui.hint(`Add ${binDir} to your PATH so Appium can find ffmpeg.`);
  } else {
    ui.hint(`Add it to your shell profile so Appium can find it: export PATH="${binDir}:$PATH"`);
  }
}

/** iOS screen recording needs ffmpeg on the Appium machine (XCUITest encodes with it); Android
 * records on-device and needs nothing. Installs a static build into the Traceback data dir so
 * no brew/package manager is required. */
async function ensureFfmpeg(ui: UIService, skipConfirm: boolean): Promise<void> {
  if (commandExists('ffmpeg')) {
    const version = execSync('ffmpeg --version', { encoding: 'utf-8' }).trim().split('\n')[0];
    ui.success(`ffmpeg already installed (${version})`);
    return;
  }

  const asset = ffmpegAssetName();
  if (!asset) {
    ui.warn(
      `No prebuilt ffmpeg available for ${process.platform}/${process.arch} — install it manually so iOS runs can record video.`,
    );
    return;
  }

  const binPath = ffmpegBinPath();
  const binDir = path.dirname(binPath);
  if (fs.existsSync(binPath)) {
    ui.success(`ffmpeg already installed (${binPath})`);
    printFfmpegPathHint(ui, binDir);
    return;
  }

  ui.warn(
    'ffmpeg not found — needed for iOS screen recordings (Android records on-device, no ffmpeg needed).',
  );
  if (!skipConfirm) {
    const { confirm } = await import('@inquirer/prompts');
    const install = await confirm({
      message:
        'Download a static ffmpeg build into the Traceback data dir (no brew/package manager needed)?',
      default: true,
    });
    if (!install) {
      ui.hint("Skipped. iOS runs will pass but won't include a screen recording.");
      return;
    }
  }

  ui.info('Downloading static ffmpeg...');
  fs.mkdirSync(binDir, { recursive: true });
  try {
    const res = await fetch(`${FFMPEG_RELEASE_BASE}/${asset}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    await fs.promises.writeFile(binPath, Buffer.from(await res.arrayBuffer()));
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  } catch (err) {
    ui.error(`ffmpeg download failed: ${err instanceof Error ? err.message : String(err)}`);
    ui.hint('Retry `traceback setup` later, or install ffmpeg yourself.');
    return;
  }

  try {
    const version = execSync(`"${binPath}" -version`, { encoding: 'utf-8' }).trim().split('\n')[0];
    ui.success(`ffmpeg installed (${version})`);
  } catch {
    ui.error(`ffmpeg was downloaded to ${binPath} but couldn't run — try installing it manually.`);
    return;
  }
  printFfmpegPathHint(ui, binDir);
}

/** Appium's own doctor treats a working JDK as a required (not optional) check for the
 * uiautomator2 driver — without one, `appium driver install` still succeeds, but a real session
 * fails later with a much less obvious Java error. Check-only, like adb/Xcode below: which JDK
 * install is right (brew, apt, Adoptium, ...) varies too much by platform to safely automate. */
function checkJava(ui: UIService): void {
  try {
    const output = execSync('java -version 2>&1', { encoding: 'utf-8', timeout: 5000 }).trim();
    const version = output.split('\n')[0] || 'java';
    ui.success(`Java found (${version})`);
  } catch {
    ui.warn('Java not found — the Android (uiautomator2) driver needs a JDK to run.');
    if (process.platform === 'darwin') {
      ui.hint('Install one with `brew install openjdk@17` (brew prints the PATH/JAVA_HOME');
      ui.hint('export commands it needs), or grab one from https://adoptium.net.');
    } else if (process.platform === 'linux') {
      ui.hint('Install one with your package manager (e.g. `apt install openjdk-17-jdk`),');
      ui.hint('or grab one from https://adoptium.net.');
    } else {
      ui.hint('Install a JDK from https://adoptium.net and make sure `java` is on your PATH.');
    }
  }
}

function checkAndroidSdk(ui: UIService): void {
  if (commandExists('adb')) {
    ui.success('Android platform-tools (adb) found.');
    return;
  }
  ui.warn('adb not found — needed to run tests on Android emulators/devices.');
  ui.hint('Install Android Studio (https://developer.android.com/studio) or the standalone');
  ui.hint('platform-tools package, then make sure `adb` is on your PATH.');
}

function checkXcode(ui: UIService): void {
  if (process.platform !== 'darwin') return; // iOS testing only exists on macOS
  try {
    // Not `xcrun --version` — that succeeds even when `xcode-select` points at the bare
    // Command Line Tools, since xcrun itself resolves fine there; `simctl` (what iOS testing
    // actually needs) only ships inside full Xcode.app's Developer directory, so checking it
    // directly is the only way to catch the misconfigured-but-"found" case below.
    execSync('xcrun simctl list devices', { stdio: 'pipe', timeout: 5000 });
    ui.success('Xcode Command Line Tools found.');
  } catch {
    // Xcode.app already installed but `xcode-select` still points at the bare Command Line
    // Tools (which don't ship `simctl`) is a different problem than Xcode not being installed
    // at all — `xcode-select --install` doesn't fix it (it only offers the bare CLT, not a
    // path change), so that generic hint would send someone with Xcode already installed in
    // circles.
    if (xcodeAppInstalled()) {
      ui.warn(
        'Xcode is installed, but `xcode-select` still points at the bare Command Line Tools.',
      );
      ui.hint('Fix it with: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer');
    } else {
      ui.warn('Xcode Command Line Tools not found — needed to run tests on iOS simulators.');
      ui.hint('Install them with `xcode-select --install`.');
    }
  }
}

/** Picks any available iOS Simulator device to build WebDriverAgent against — the compiled app
 * bundle this produces isn't destination-specific (see wda-prebuild.ts), so which one gets
 * picked here doesn't need to match whatever a real run later targets. */
function pickWdaBuildDestination(): string | null {
  try {
    const raw = execSync('xcrun simctl list devices available --json', {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const parsed = JSON.parse(raw) as {
      devices: Record<string, Array<{ udid: string; name: string; isAvailable?: boolean }>>;
    };
    for (const runtime of Object.keys(parsed.devices)) {
      const iphone = parsed.devices[runtime]?.find(
        (d) => d.name.startsWith('iPhone') && d.isAvailable !== false,
      );
      if (iphone) return iphone.udid;
    }
  } catch {
    // Falls through to null below — treated the same as "no simulator available".
  }
  return null;
}

/** Pre-builds WebDriverAgent once here instead of on someone's first real test run — see
 * appium.bridge.ts's console.log for the incident this exists to prevent (a perfectly healthy,
 * still-building WDA process getting killed mid-run because a multi-minute compile with nothing
 * on screen looked indistinguishable from a hang). Best-effort throughout: every failure path
 * just leaves that first-run cost where it already was, not a regression. */
async function ensureWdaPrebuilt(ui: UIService, skipConfirm: boolean): Promise<void> {
  if (process.platform !== 'darwin') return; // iOS testing only exists on macOS

  const projectPath = wdaProjectPath();
  if (!projectPath) return; // xcuitest driver isn't installed -- nothing to build

  if (wdaIsPrebuilt()) {
    ui.success('WebDriverAgent already pre-built — iOS runs will skip the first-run compile.');
    return;
  }

  try {
    execSync('xcrun simctl list devices', { stdio: 'pipe', timeout: 5000 });
  } catch {
    ui.warn("Skipping WebDriverAgent pre-build — Xcode/Simulator isn't usable yet (see above).");
    ui.hint('Fix that, then run `traceback setup` again to pre-build it.');
    return;
  }

  const udid = pickWdaBuildDestination();
  if (!udid) {
    ui.warn('Skipping WebDriverAgent pre-build — no available iOS Simulator device found.');
    ui.hint(
      'Create one in Xcode (Window > Devices and Simulators), then run `traceback setup` again.',
    );
    return;
  }

  if (!skipConfirm) {
    const { confirm } = await import('@inquirer/prompts');
    const install = await confirm({
      message:
        "Pre-build WebDriverAgent now (a few minutes, one-time) so it doesn't stall your first real iOS run?",
      default: true,
    });
    if (!install) {
      ui.hint('Skipped — the first real iOS run will build it instead (also a few minutes).');
      return;
    }
  }

  ui.info('Building WebDriverAgent via Xcode — this can take a few minutes...');
  const code = await runStreamed('xcodebuild', [
    'build-for-testing',
    '-project',
    projectPath,
    '-scheme',
    'WebDriverAgentRunner',
    '-derivedDataPath',
    wdaDerivedDataPath(),
    '-destination',
    `id=${udid}`,
  ]);

  if (code === 0 && wdaIsPrebuilt()) {
    ui.success('WebDriverAgent pre-built — future iOS runs will skip the first-run compile.');
  } else {
    ui.error('WebDriverAgent pre-build failed — see the output above.');
    ui.hint('iOS runs will fall back to building it on first use instead.');
  }
}
