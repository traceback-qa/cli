/**
 * Setup command — automated installer and environment configurator for mobile & web testing.
 *
 * Scans dependencies based on chosen platform target (Android, iOS, Web, or All),
 * leverages system package managers (Homebrew, Winget) for 1-click SDK installation,
 * provides permission-resilient Appium and driver installation with parallel downloads,
 * enriches the in-memory PATH for zero-restart testing, and runs a post-setup smoke test.
 */

import type { Command } from 'commander';
import { execSync, spawn } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import type { UIService } from '../../infrastructure/ui/ui.types.js';
import { getDataDir } from '../../platform/paths.js';
import { xcodeAppInstalled, detectDevices } from '../../infrastructure/mobile/device.detector.js';
import {
  findAndroidSdk,
  findJavaJdk,
  enrichMobileEnv,
  getPreferredShellProfile,
  checkProfileHasEnv,
  writeMobileEnvToShellProfile,
} from '../../infrastructure/mobile/sdk.detector.js';
import {
  appiumHome,
  wdaDerivedDataPath,
  wdaIsPrebuilt,
  wdaProjectPath,
} from '../../infrastructure/mobile/wda-prebuild.js';
import {
  detectPackageManager,
  getPackageInstallPlan,
  executeInstallPlan,
  getIsolatedNpmDirs,
  type InstallPlan,
} from '../../infrastructure/mobile/package-manager.js';
import { findChromiumBrowser } from '../../infrastructure/browser/chrome.launcher.js';
import { configureCloudMcp } from '../../infrastructure/mcp/client-configurator.js';

type ContextGetter = typeof GetContextFn;

export type TargetPlatform = 'all' | 'android' | 'ios' | 'web';

interface DependencyStatus {
  name: string;
  category: 'core' | 'driver' | 'media' | 'sdk' | 'optimization' | 'browser';
  installed: boolean;
  version?: string;
  path?: string;
  actionRequired?: string;
  autoInstallable: boolean;
  installPlan?: InstallPlan | null;
}

const DRIVERS: { name: string; label: string; platform: 'android' | 'ios' }[] = [
  { name: 'uiautomator2', label: 'Android (uiautomator2)', platform: 'android' },
  { name: 'xcuitest', label: 'iOS (xcuitest)', platform: 'ios' },
];

export function registerSetupCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('setup')
    .description('Install Appium, drivers, and SDKs needed for Traceback test automation')
    .option('-p, --platform <platform>', 'Target platform to configure: all, android, ios, web')
    .option(
      '-y, --yes',
      'Skip confirmation prompts and auto-install all missing dependencies',
      false,
    )
    .option('--quick', 'Fast setup (skips optional steps like WebDriverAgent pre-build)', false)
    .option('--skip-wda', 'Skip iOS WebDriverAgent pre-build step', false)
    .option('--skip-mcp', 'Skip automatic Cloud MCP configuration for AI IDEs', false)
    .action(async function (
      this: Command,
      options: {
        platform?: string;
        yes: boolean;
        quick: boolean;
        skipWda: boolean;
        skipMcp: boolean;
      },
    ) {
      const ctx = getContext(this);
      if (!ctx) return;
      const ui = ctx.infra.ui;

      // Populate in-memory environment variables right away
      enrichMobileEnv();

      ui.banner('Traceback Setup', 'Automated Tooling & Environment Configurator');

      // ── Step 0: Platform Selection ────────────────────────────
      let targetPlatform: TargetPlatform = 'all';
      if (options.platform) {
        const p = options.platform.toLowerCase();
        if (['all', 'android', 'ios', 'web'].includes(p)) {
          targetPlatform = p as TargetPlatform;
        } else {
          ui.warn(`Unknown platform '${options.platform}'. Defaulting to 'all'.`);
        }
      } else if (!options.yes && process.stdin.isTTY) {
        const { select } = await import('@inquirer/prompts');
        targetPlatform = await select<TargetPlatform>({
          message: 'Which platform(s) would you like to configure for testing?',
          choices: [
            {
              name: `Android & iOS ${chalk.dim('(Full mobile automation environment)')}`,
              value: 'all',
            },
            {
              name: `Android only ${chalk.dim('(Appium + uiautomator2 + Java JDK + Android SDK)')}`,
              value: 'android',
            },
            ...(process.platform === 'darwin'
              ? [
                  {
                    name: `iOS only ${chalk.dim('(Appium + xcuitest + Xcode Simulator tools)')}`,
                    value: 'ios' as const,
                  },
                ]
              : []),
            {
              name: `Web testing only ${chalk.dim('(Verify Chrome/Chromium browser configuration)')}`,
              value: 'web',
            },
          ],
        });
      }

      ui.info(`Target platform: ${chalk.cyan(targetPlatform.toUpperCase())}`);

      // ── Special Case: Web Only ────────────────────────────────
      if (targetPlatform === 'web') {
        const browser = findChromiumBrowser();
        ui.step('1/1', 'Web Browser Verification');
        if (browser) {
          ui.success(
            `Chromium browser detected: ${chalk.bold(browser.name)} ${chalk.dim(`(${browser.executablePath})`)}`,
          );
          ui.success(
            'Web testing is fully configured! Run `traceback tests` to launch a web test.',
          );
        } else {
          ui.warn('No Chromium-based browser (Chrome, Brave, Edge, Arc) was detected.');
          const pm = detectPackageManager();
          if (pm?.manager === 'brew') {
            ui.hint('Install with: brew install --cask google-chrome');
          } else {
            ui.hint('Please install Google Chrome or Brave to execute local browser tests.');
          }
        }
        return;
      }

      // ── Step 1: Up-Front Dependency Scan ──────────────────────
      const scanSpinner = ui.spinner('Scanning local mobile dependencies and SDKs...');
      const depStatus = scanDependenciesForPlatform(targetPlatform);
      scanSpinner.stop();

      const missingInstallable = depStatus.filter((d) => !d.installed && d.autoInstallable);
      const manualChecks = depStatus.filter((d) => !d.installed && !d.autoInstallable);

      // Render pre-scan summary checklist
      ui.step('1/4', 'Pre-flight Dependency Check');
      for (const dep of depStatus) {
        if (dep.installed) {
          ui.success(`${dep.name}: ${chalk.dim(dep.version || dep.path || 'Configured')}`);
        } else if (dep.autoInstallable) {
          const via = dep.installPlan ? ` via ${dep.installPlan.command}` : '';
          ui.warn(
            `${dep.name}: ${chalk.yellow('Missing')} ${chalk.dim(`→ Auto-installable${via}`)}`,
          );
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

      // 3.1 SDK Dependencies (Java / Android SDK if auto-installable via package manager)
      const sdkPlans = missingInstallable.filter((d) => d.category === 'sdk' && d.installPlan);
      if (sdkPlans.length > 0) {
        ui.step('2/4', 'Platform SDKs & Tools');
        for (const dep of sdkPlans) {
          if (!dep.installPlan) continue;
          ui.info(`Installing ${dep.name} (${dep.installPlan.description})...`);
          const res = await executeInstallPlan(dep.installPlan);
          if (res.success) {
            ui.success(`Installed ${dep.name}.`);
          } else {
            ui.warn(
              `Package manager install for ${dep.name} exited with code ${res.exitCode}. Falling back to manual instructions.`,
            );
          }
        }
        enrichMobileEnv();
      } else {
        ui.step('2/4', 'Core Automation Engine & Drivers');
      }

      // 3.2 Appium Engine & Drivers + ffmpeg (executed concurrently)
      await ensureAppiumWithFallback(ui);
      enrichMobileEnv();

      // Run Driver Installation & Media Download in Parallel
      const tasks: Promise<void>[] = [];
      tasks.push(ensureDriversForPlatform(ui, targetPlatform));
      tasks.push(ensureFfmpeg(ui));
      await Promise.all(tasks);

      // 3.3 Environment Variables & iOS Optimizations
      ui.step('3/4', 'Environment Sync & Profile Persistence');
      ensureMobileEnvironment(ui);

      if (targetPlatform === 'all' || targetPlatform === 'android') {
        checkJava(ui);
        checkAndroidSdk(ui);
      }

      if ((targetPlatform === 'all' || targetPlatform === 'ios') && process.platform === 'darwin') {
        checkXcode(ui);
        const shouldPrebuildWda = !options.quick && !options.skipWda;
        if (shouldPrebuildWda) {
          ui.step('4/4', 'iOS Simulator Optimization');
          await ensureWdaPrebuilt(ui, options.yes);
        } else {
          ui.info(
            chalk.dim(
              'Skipping WebDriverAgent pre-build (will compile on demand during first iOS run).',
            ),
          );
        }
      } else {
        ui.step('4/4', 'Verifying Environment Readiness');
      }

      // 3.4 AI Coding Agent & Cloud MCP Auto-Configuration
      if (!options.skipMcp) {
        try {
          const token = await ctx.infra.auth.getToken();
          const config = await ctx.infra.config.loadGlobalConfig();
          const mcpResults = configureCloudMcp({
            token: token?.accessToken,
            apiUrl: config.apiUrl,
          });
          const successfulMcp = mcpResults.filter((r) => r.success);
          if (successfulMcp.length > 0) {
            ui.success(
              `Configured Traceback Cloud MCP endpoint in: ${successfulMcp.map((r) => chalk.bold(r.clientName)).join(', ')}.`,
            );
          }
        } catch {
          // Ignore MCP configuration errors during setup
        }
      }

      // ── Step 4: Final Environment Matrix Card & Smoke Test ────
      enrichMobileEnv();
      ui.hint('');
      const finalScan = scanDependenciesForPlatform(targetPlatform);
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
            `\nNote: ${manualChecks.length} platform component(s) require manual setup (see suggestions above).`,
          ),
        );
      }

      ui.success('Setup completed successfully! Environment active in memory.');

      // ── Post-Setup Smoke Test & Interactive Next Action ───────
      try {
        const detection = detectDevices();
        const activeDevices = detection.devices;
        if (activeDevices.length > 0) {
          ui.hint('');
          ui.info(
            chalk.green.bold(
              `⚡ Detected ${activeDevices.length} active device(s): ${activeDevices.map((d) => `${d.name} (${d.platform})`).join(', ')}`,
            ),
          );

          if (!options.yes && process.stdin.isTTY) {
            const { confirm } = await import('@inquirer/prompts');
            const runNow = await confirm({
              message: 'Would you like to run a mobile verification test now?',
              default: true,
            });

            if (runNow) {
              const mobileCmd = program.commands.find((c) => c.name() === 'mobile');
              if (mobileCmd) {
                await mobileCmd.parseAsync(['node', 'traceback', 'mobile', 'verify']);
                return;
              }
            }
          }
        }
      } catch {
        // Silently skip if smoke probe fails
      }

      ui.hint(
        `\nReady to test! Run ${chalk.cyan('traceback mobile verify')} or ${chalk.cyan('traceback tests')}.`,
      );
    });
}

function commandExists(cmd: string): boolean {
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

function scanDependenciesForPlatform(platform: TargetPlatform): DependencyStatus[] {
  const isMac = process.platform === 'darwin';
  const pm = detectPackageManager();
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

  if (platform === 'all' || platform === 'android') {
    list.push({
      name: 'Android Driver (uiautomator2)',
      category: 'driver',
      installed: installedDrivers.has('uiautomator2'),
      version: installedDrivers.has('uiautomator2') ? 'Installed' : undefined,
      autoInstallable: true,
    });
  }

  if ((platform === 'all' || platform === 'ios') && isMac) {
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
    const ffmpegPlan = getPackageInstallPlan('ffmpeg', pm);
    list.push({
      name: 'ffmpeg Screen Recorder',
      category: 'media',
      installed: false,
      autoInstallable: true,
      installPlan: ffmpegPlan,
    });
  }

  // Java (Android only or All)
  if (platform === 'all' || platform === 'android') {
    const java = findJavaJdk();
    if (java) {
      list.push({
        name: 'Java JDK 17',
        category: 'sdk',
        installed: true,
        version: java.onPath ? java.version || 'Found on PATH' : `Found (${java.javaHome})`,
        autoInstallable: false,
      });
    } else {
      const javaPlan = getPackageInstallPlan('java', pm);
      list.push({
        name: 'Java JDK 17',
        category: 'sdk',
        installed: false,
        actionRequired: javaPlan
          ? `Auto-installable via ${javaPlan.command}`
          : 'Install via https://adoptium.net or your system package manager',
        autoInstallable: Boolean(javaPlan),
        installPlan: javaPlan,
      });
    }
  }

  // Android SDK (Android only or All)
  if (platform === 'all' || platform === 'android') {
    const sdk = findAndroidSdk();
    if (sdk) {
      list.push({
        name: 'Android platform-tools (adb)',
        category: 'sdk',
        installed: true,
        version: sdk.onPath ? 'Available on PATH' : `Found (${sdk.sdkPath})`,
        autoInstallable: false,
      });
    } else {
      const sdkPlan = getPackageInstallPlan('android-sdk', pm);
      list.push({
        name: 'Android platform-tools (adb)',
        category: 'sdk',
        installed: false,
        actionRequired: sdkPlan
          ? `Auto-installable via ${sdkPlan.command}`
          : 'Install Android Studio or platform-tools',
        autoInstallable: Boolean(sdkPlan),
        installPlan: sdkPlan,
      });
    }
  }

  // Xcode & WebDriverAgent (iOS only or All, macOS only)
  if ((platform === 'all' || platform === 'ios') && isMac) {
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
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env } });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Ensures Appium is installed. Tries global npm first, falls back to isolated user directory if permissions fail.
 */
async function ensureAppiumWithFallback(ui: UIService): Promise<void> {
  if (commandExists('appium')) {
    const version = execSync('appium --version', { encoding: 'utf-8' }).trim();
    ui.success(`Appium is ready (${chalk.dim(`v${version}`)}).`);
    return;
  }

  ui.info('Installing Appium via npm...');
  // 1. Try global install
  let code = await runStreamed('npm', ['install', '-g', 'appium']);
  if (code === 0 && commandExists('appium')) {
    ui.success('Appium installed globally.');
    return;
  }

  // 2. Fallback to isolated user-space prefix if global install failed (e.g. EACCES permissions)
  ui.warn('Global npm install failed or restricted. Installing into user-isolated directory...');
  const { npmPrefix, npmBinDir, binDir } = getIsolatedNpmDirs();
  fs.mkdirSync(npmPrefix, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  code = await runStreamed('npm', ['install', '--prefix', npmPrefix, 'appium']);
  if (code === 0) {
    enrichMobileEnv();
    if (commandExists('appium')) {
      ui.success(`Appium installed in isolated environment (${chalk.dim(npmBinDir)}).`);
      return;
    }
  }

  ui.error('Appium installation failed.');
  ui.hint('Retry manually with `npm install -g appium` or check permissions.');
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

async function ensureDriversForPlatform(ui: UIService, platform: TargetPlatform): Promise<void> {
  if (!commandExists('appium')) return;

  const installed = listInstalledDrivers();
  const applicable = DRIVERS.filter(
    (d) =>
      (platform === 'all' || platform === d.platform) &&
      (d.platform !== 'ios' || process.platform === 'darwin'),
  );
  const needed = applicable.filter((d) => !installed.has(d.name));

  if (needed.length === 0) {
    ui.success('All required Appium drivers are installed.');
    return;
  }

  // Install drivers in parallel to save time
  const installDriver = async (driver: (typeof DRIVERS)[0]): Promise<void> => {
    ui.info(`Installing driver: ${driver.label}...`);
    const code = await runStreamed('appium', ['driver', 'install', driver.name]);
    if (code === 0) {
      ui.success(`Driver installed: ${driver.label}`);
    } else {
      ui.error(`Failed to install driver: ${driver.label}`);
    }
  };

  await Promise.allSettled(needed.map(installDriver));
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
    enrichMobileEnv();
    ui.success(`ffmpeg downloaded and configured (${chalk.dim(binPath)}).`);
  } catch (err) {
    ui.error(`ffmpeg download failed: ${err instanceof Error ? err.message : String(err)}`);
    ui.hint('You can install ffmpeg manually with Homebrew (`brew install ffmpeg`).');
  }
}

function ensureMobileEnvironment(ui: UIService): void {
  enrichMobileEnv();
  const profilePath = getPreferredShellProfile();
  const status = checkProfileHasEnv(profilePath);

  const sdk = findAndroidSdk();
  const java = findJavaJdk();

  if (
    (!status.hasAndroid && sdk?.sdkPath) ||
    (!status.hasJava && java?.javaHome) ||
    !status.hasTracebackBin
  ) {
    const written = writeMobileEnvToShellProfile(
      profilePath,
      status.hasAndroid ? undefined : sdk?.sdkPath,
      status.hasJava ? undefined : java?.javaHome,
    );
    if (written) {
      ui.success(`Synced environment configuration to ${chalk.dim(profilePath)}.`);
    }
  }
}

function checkJava(ui: UIService): void {
  const java = findJavaJdk();
  if (java) {
    if (java.onPath) {
      ui.success(`Java JDK found (${chalk.dim(java.version || 'Found')}).`);
    } else {
      ui.success(`Java JDK found at ${chalk.dim(java.javaHome)}.`);
    }
  } else {
    ui.warn('Java JDK not found — Android uiautomator2 requires a JDK.');
    ui.hint('Install via `brew install openjdk@17` or grab one from https://adoptium.net.');
  }
}

function checkAndroidSdk(ui: UIService): void {
  const sdk = findAndroidSdk();
  if (sdk) {
    if (sdk.onPath) {
      ui.success(`Android platform-tools (adb) verified (${chalk.dim(sdk.adbPath)}).`);
    } else {
      ui.success(`Android SDK found at ${chalk.dim(sdk.sdkPath)}.`);
    }
  } else {
    ui.warn('Android platform-tools (adb) not found — required for Android emulators/devices.');
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

async function ensureWdaPrebuilt(ui: UIService, skipConfirm = false): Promise<void> {
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

  if (!skipConfirm && process.stdin.isTTY) {
    const { confirm } = await import('@inquirer/prompts');
    const prebuild = await confirm({
      message:
        'Pre-build WebDriverAgent now (~2 min)? (Avoids initial launch delays during iOS tests)',
      default: true,
    });
    if (!prebuild) {
      ui.info(chalk.dim('Skipping WebDriverAgent pre-build (will build on first iOS run).'));
      return;
    }
  }

  ui.info('Pre-building WebDriverAgent for iOS (this can take 1-2 minutes)...');
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
