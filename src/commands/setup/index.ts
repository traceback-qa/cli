/**
 * Setup command — automated installer and environment configurator for mobile testing.
 *
 * Scans all requirements up front, prompts for a single confirmation, runs structured
 * installation steps with live progress, and renders a final environment matrix card.
 */

import type { Command } from 'commander';
import { execSync, spawn } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import type { UIService } from '../../infrastructure/ui/ui.types.js';
import { getDataDir } from '../../platform/paths.js';
import { xcodeAppInstalled } from '../../infrastructure/mobile/device.detector.js';
import {
  appiumHome,
  wdaDerivedDataPath,
  wdaIsPrebuilt,
  wdaProjectPath,
} from '../../infrastructure/mobile/wda-prebuild.js';

type ContextGetter = typeof GetContextFn;

interface DependencyStatus {
  name: string;
  category: 'core' | 'driver' | 'media' | 'sdk' | 'optimization';
  installed: boolean;
  version?: string;
  path?: string;
  actionRequired?: string;
  autoInstallable: boolean;
}

const DRIVERS: { name: string; label: string; macOnly: boolean }[] = [
  { name: 'uiautomator2', label: 'Android (uiautomator2)', macOnly: false },
  { name: 'xcuitest', label: 'iOS (xcuitest)', macOnly: true },
];

export function registerSetupCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('setup')
    .description('Install Appium and the drivers needed for `traceback mobile verify`')
    .option('-y, --yes', 'Skip confirmation prompts and install all missing dependencies', false)
    .action(async function (this: Command, options: { yes: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;
      const ui = ctx.infra.ui;

      ui.banner('Traceback Mobile Setup', 'Automated Tooling & Environment Configurator');

      // ── Step 1: Up-Front Dependency Scan ──────────────────────
      const scanSpinner = ui.spinner('Scanning local mobile dependencies and SDKs...');
      const depStatus = scanAllDependencies();
      scanSpinner.stop();

      const missingInstallable = depStatus.filter((d) => !d.installed && d.autoInstallable);
      const manualChecks = depStatus.filter((d) => !d.installed && !d.autoInstallable);

      // Render pre-scan summary checklist
      ui.step('1/4', 'Pre-flight Environment Check');
      for (const dep of depStatus) {
        if (dep.installed) {
          ui.success(`${dep.name}: ${chalk.dim(dep.version || dep.path || 'Configured')}`);
        } else if (dep.autoInstallable) {
          ui.warn(`${dep.name}: ${chalk.yellow('Missing')} ${chalk.dim('→ Will be installed')}`);
        } else {
          ui.warn(
            `${dep.name}: ${chalk.yellow('Not found')} ${chalk.dim(`(${dep.actionRequired || 'Manual install required'})`)}`,
          );
        }
      }

      // ── Step 2: Single Batch Confirmation ─────────────────────
      if (missingInstallable.length > 0 && !options.yes && process.stdin.isTTY) {
        ui.hint('');
        const { confirm } = await import('@inquirer/prompts');
        const proceed = await confirm({
          message: `Install ${missingInstallable.length} missing package(s) (${missingInstallable.map((d) => d.name).join(', ')})?`,
          default: true,
        });

        if (!proceed) {
          ui.warn('Setup cancelled. You can re-run `traceback setup` at any time.');
          return;
        }
      }

      // ── Step 3: Structured Step-by-Step Installation ──────────
      ui.hint('');
      ui.step('2/4', 'Core Engine & Drivers');
      await ensureAppium(ui);
      await ensureDrivers(ui);

      ui.step('3/4', 'Screen Recording & Media Engine');
      await ensureFfmpeg(ui);

      ui.step('4/4', 'Platform SDKs & iOS Optimizations');
      checkJava(ui);
      checkAndroidSdk(ui);
      checkXcode(ui);
      await ensureWdaPrebuilt(ui);

      // ── Step 4: Final Environment Matrix Table Card ───────────
      ui.hint('');
      const finalScan = scanAllDependencies();
      const headers = ['Component', 'Status', 'Version / Detail'];
      const rows = finalScan.map((d) => [
        d.name,
        d.installed ? chalk.green('✔ Configured') : chalk.yellow('⚠ Action Required'),
        d.version || d.path || d.actionRequired || '—',
      ]);

      ui.table(headers, rows);

      if (manualChecks.length > 0) {
        ui.hint(
          chalk.yellow(
            `\nNote: ${manualChecks.length} platform SDK(s) require manual installation if you plan to test on them (see suggestions above).`,
          ),
        );
      }

      ui.success(
        'Setup complete! Run `traceback doctor` or `traceback mobile verify` to start testing.',
      );
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

function scanAllDependencies(): DependencyStatus[] {
  const isMac = process.platform === 'darwin';
  const list: DependencyStatus[] = [];

  // Appium
  if (commandExists('appium')) {
    try {
      const version = execSync('appium --version', { encoding: 'utf-8', timeout: 3000 }).trim();
      list.push({
        name: 'Appium Server',
        category: 'core',
        installed: true,
        version: `v${version}`,
        autoInstallable: true,
      });
    } catch {
      list.push({
        name: 'Appium Server',
        category: 'core',
        installed: false,
        autoInstallable: true,
      });
    }
  } else {
    list.push({ name: 'Appium Server', category: 'core', installed: false, autoInstallable: true });
  }

  // Drivers
  const installedDrivers = listInstalledDrivers();
  list.push({
    name: 'Android Driver (uiautomator2)',
    category: 'driver',
    installed: installedDrivers.has('uiautomator2'),
    version: installedDrivers.has('uiautomator2') ? 'Installed' : undefined,
    autoInstallable: true,
  });

  if (isMac) {
    list.push({
      name: 'iOS Driver (xcuitest)',
      category: 'driver',
      installed: installedDrivers.has('xcuitest'),
      version: installedDrivers.has('xcuitest') ? 'Installed' : undefined,
      autoInstallable: true,
    });
  }

  // ffmpeg
  const binPath = ffmpegBinPath();
  if (commandExists('ffmpeg') || fs.existsSync(binPath)) {
    list.push({
      name: 'ffmpeg Screen Recorder',
      category: 'media',
      installed: true,
      path: fs.existsSync(binPath) ? binPath : 'system PATH',
      autoInstallable: true,
    });
  } else {
    list.push({
      name: 'ffmpeg Screen Recorder',
      category: 'media',
      installed: false,
      autoInstallable: true,
    });
  }

  // Java
  try {
    const javaOut = execSync('java -version 2>&1', { encoding: 'utf-8', timeout: 3000 }).trim();
    const javaVer = javaOut.split('\n')[0] || 'Found';
    list.push({
      name: 'Java JDK 17',
      category: 'sdk',
      installed: true,
      version: javaVer,
      autoInstallable: false,
    });
  } catch {
    list.push({
      name: 'Java JDK 17',
      category: 'sdk',
      installed: false,
      actionRequired: 'Install via `brew install openjdk@17` or https://adoptium.net',
      autoInstallable: false,
    });
  }

  // Android SDK
  if (commandExists('adb')) {
    list.push({
      name: 'Android platform-tools (adb)',
      category: 'sdk',
      installed: true,
      version: 'Available on PATH',
      autoInstallable: false,
    });
  } else {
    list.push({
      name: 'Android platform-tools (adb)',
      category: 'sdk',
      installed: false,
      actionRequired: 'Install Android Studio or platform-tools',
      autoInstallable: false,
    });
  }

  // Xcode
  if (isMac) {
    try {
      execSync('xcrun simctl list devices', { stdio: 'pipe', timeout: 5000 });
      list.push({
        name: 'Xcode Command Line Tools',
        category: 'sdk',
        installed: true,
        version: 'Configured with simctl',
        autoInstallable: false,
      });
    } catch {
      list.push({
        name: 'Xcode Command Line Tools',
        category: 'sdk',
        installed: false,
        actionRequired: xcodeAppInstalled()
          ? 'Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`'
          : 'Run `xcode-select --install`',
        autoInstallable: false,
      });
    }

    // WebDriverAgent Prebuild
    list.push({
      name: 'WebDriverAgent Pre-build',
      category: 'optimization',
      installed: wdaIsPrebuilt(),
      version: wdaIsPrebuilt() ? 'Pre-built' : undefined,
      autoInstallable: true,
    });
  }

  return list;
}

async function runStreamed(command: string, args: string[]): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function ensureAppium(ui: UIService): Promise<void> {
  if (commandExists('appium')) {
    const version = execSync('appium --version', { encoding: 'utf-8' }).trim();
    ui.success(`Appium is ready (${chalk.dim(`v${version}`)}).`);
    return;
  }

  ui.info('Installing Appium globally via npm...');
  const code = await runStreamed('npm', ['install', '-g', 'appium']);
  if (code === 0 && commandExists('appium')) {
    ui.success('Appium installed successfully.');
  } else {
    ui.error('Appium installation failed.');
    ui.hint('Retry manually with `npm install -g appium`.');
  }
}

function listInstalledDrivers(): Set<string> {
  const set = new Set<string>();
  const home = appiumHome();

  if (fs.existsSync(path.join(home, 'node_modules', 'appium-uiautomator2-driver'))) {
    set.add('uiautomator2');
  }
  if (fs.existsSync(path.join(home, 'node_modules', 'appium-xcuitest-driver'))) {
    set.add('xcuitest');
  }

  return set;
}

async function ensureDrivers(ui: UIService): Promise<void> {
  if (!commandExists('appium')) return;

  const installed = listInstalledDrivers();
  const applicable = DRIVERS.filter((d) => !d.macOnly || process.platform === 'darwin');
  const needed = applicable.filter((d) => !installed.has(d.name));

  if (needed.length === 0) {
    ui.success('All required Appium drivers are installed.');
    return;
  }

  for (const driver of needed) {
    ui.info(`Installing driver: ${driver.label}...`);
    const code = await runStreamed('appium', ['driver', 'install', driver.name]);
    if (code === 0) {
      ui.success(`Driver installed: ${driver.label}`);
    } else {
      ui.error(`Failed to install driver: ${driver.label}`);
    }
  }
}

const FFMPEG_RELEASE_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download';

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

async function ensureFfmpeg(ui: UIService): Promise<void> {
  if (commandExists('ffmpeg')) {
    const version = execSync('ffmpeg --version', { encoding: 'utf-8' }).trim().split('\n')[0];
    ui.success(`ffmpeg found on PATH (${chalk.dim(version?.slice(0, 30))}).`);
    return;
  }

  const binPath = ffmpegBinPath();
  const binDir = path.dirname(binPath);
  if (fs.existsSync(binPath)) {
    ui.success(`ffmpeg is ready (${chalk.dim(binPath)}).`);
    printFfmpegPathHint(ui, binDir);
    return;
  }

  const asset = ffmpegAssetName();
  if (!asset) {
    ui.warn('No prebuilt ffmpeg available for this platform architecture.');
    return;
  }

  ui.info('Downloading standalone ffmpeg binary into Traceback data directory...');
  fs.mkdirSync(binDir, { recursive: true });
  try {
    const res = await fetch(`${FFMPEG_RELEASE_BASE}/${asset}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    await fs.promises.writeFile(binPath, Buffer.from(await res.arrayBuffer()));
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
    ui.success(`ffmpeg downloaded and configured (${chalk.dim(binPath)}).`);
    printFfmpegPathHint(ui, binDir);
  } catch (err) {
    ui.error(`ffmpeg download failed: ${err instanceof Error ? err.message : String(err)}`);
    ui.hint('You can install ffmpeg manually with Homebrew (`brew install ffmpeg`).');
  }
}

function checkJava(ui: UIService): void {
  try {
    const output = execSync('java -version 2>&1', { encoding: 'utf-8', timeout: 5000 }).trim();
    const version = output.split('\n')[0] || 'java';
    ui.success(`Java JDK found (${chalk.dim(version)}).`);
  } catch {
    ui.warn('Java JDK not found — Android uiautomator2 requires a JDK.');
    ui.hint('Install via `brew install openjdk@17` or grab one from https://adoptium.net.');
  }
}

function checkAndroidSdk(ui: UIService): void {
  if (commandExists('adb')) {
    ui.success('Android platform-tools (adb) verified.');
  } else {
    ui.warn('adb not found on PATH — required for Android emulators/devices.');
    ui.hint('Install Android Studio (https://developer.android.com/studio) or platform-tools.');
  }
}

function checkXcode(ui: UIService): void {
  if (process.platform !== 'darwin') return;
  try {
    execSync('xcrun simctl list devices', { stdio: 'pipe', timeout: 5000 });
    ui.success('Xcode Command Line Tools & iOS Simulator tools verified.');
  } catch {
    if (xcodeAppInstalled()) {
      ui.warn('Xcode is installed, but `xcode-select` still points at bare Command Line Tools.');
      ui.hint('Fix with: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer');
    } else {
      ui.warn('Xcode Command Line Tools not found — required for iOS simulators.');
      ui.hint('Install with: xcode-select --install');
    }
  }
}

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
    // ignore
  }
  return null;
}

async function ensureWdaPrebuilt(ui: UIService): Promise<void> {
  if (process.platform !== 'darwin') return;

  const projectPath = wdaProjectPath();
  if (!projectPath) return;

  if (wdaIsPrebuilt()) {
    ui.success('WebDriverAgent is already pre-built for iOS Simulators.');
    return;
  }

  try {
    execSync('xcrun simctl list devices', { stdio: 'pipe', timeout: 5000 });
  } catch {
    ui.warn('Skipping WebDriverAgent pre-build — Xcode/Simulator is not yet configured.');
    return;
  }

  const udid = pickWdaBuildDestination();
  if (!udid) {
    ui.warn('Skipping WebDriverAgent pre-build — no iOS Simulator device detected.');
    return;
  }

  ui.info('Pre-building WebDriverAgent for iOS (this can take a couple minutes)...');
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
    ui.success('WebDriverAgent pre-built successfully.');
  } else {
    ui.warn('WebDriverAgent pre-build did not complete; will build on demand during first run.');
  }
}
