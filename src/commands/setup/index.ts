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
 *   - Android platform-tools (`adb`) / Xcode Command Line Tools (`xcrun`): only detected, never
 *     auto-installed. These are multi-gigabyte, often-interactive installs (Android Studio,
 *     Xcode from the App Store) — the responsible move is pointing at the real installer, not
 *     silently kicking one off.
 */

import type { Command } from 'commander';
import { execSync, spawn } from 'child_process';
import type { getContext as GetContextFn } from '../../cli.js';
import type { UIService } from '../../infrastructure/ui/ui.types.js';

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
      checkAndroidSdk(ui);
      checkXcode(ui);

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
    const install = await confirm({ message: 'Install Appium now (npm install -g appium)?', default: true });
    if (!install) {
      ui.hint('Skipped. Install it yourself with `npm install -g appium` when you\'re ready.');
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
    execSync('xcrun --version', { stdio: 'pipe', timeout: 5000 });
    ui.success('Xcode Command Line Tools found.');
  } catch {
    ui.warn('Xcode Command Line Tools not found — needed to run tests on iOS simulators.');
    ui.hint('Install them with `xcode-select --install`.');
  }
}
