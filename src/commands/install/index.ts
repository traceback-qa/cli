/**
 * `traceback install` — one command to bootstrap every local dependency the mobile
 * testing flows need:
 *
 *   Homebrew → Node.js → Appium + drivers → Java 17 → Android (adb + Studio) →
 *   Xcode/CLT → Flutter
 *
 * Every step is detected first; missing tools are installed with an explicit confirm
 * (or `--yes`), heavy installs show their rough size, and anything that can't be
 * automated (full Xcode from the App Store, emulator system images) is printed as
 * step-by-step guidance. `--check` reports status without touching the machine.
 *
 * The per-tool detection → plan logic lives in `plan.ts` (pure, unit-tested); this
 * file only detects, confirms, and runs installs.
 */

import type { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { getContext as GetContextFn } from '../../cli.js';
import { commandExists, ensureAppium, ensureDrivers, runStreamed } from '../setup/index.js';
import type { UIService } from '../../infrastructure/ui/ui.types.js';
import { buildInstallPlan, type InstallStep, type ToolId, type ToolPresence } from './plan.js';

type ContextGetter = typeof GetContextFn;

const SKIPPABLE: ToolId[] = [
  'homebrew',
  'node',
  'appium',
  'java',
  'android',
  'ios',
  'flutter',
];

export function registerInstallCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('install')
    .description(
      'Install every local dependency the mobile testing flows need — Appium + drivers, ' +
        'Android SDK, Xcode tools, Flutter, and the package managers under them.',
    )
    .option('-y, --yes', 'Install everything without confirmation prompts', false)
    .option('--check', 'Only report what is installed and what is missing — change nothing', false)
    .option(
      '--skip <tools>',
      `Comma-separated tools to skip: ${SKIPPABLE.join(', ')}`,
      (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean),
    )
    .action(async function (this: Command, options: { yes: boolean; check: boolean; skip: string[] }) {
      const ctx = getContext(this);
      if (!ctx) return;
      const ui = ctx.infra.ui;

      ui.info('Checking your local mobile testing toolchain...\n');

      const presence = detectPresence();
      const plan = buildInstallPlan(process.platform, presence, options.skip ?? []);

      // Status table (the ui methods already add ✓/⚠ glyphs).
      for (const step of plan) {
        if (step.present) {
          ui.success(step.label);
        } else if (step.action === 'install') {
          ui.warn(`${step.label}${step.size ? `  (${step.size})` : ''} — will install`);
        } else {
          ui.warn(`${step.label} — manual step needed`);
        }
      }

      if (ui.isJsonMode()) {
        ui.renderJson({
          platform: process.platform,
          tools: Object.fromEntries(plan.map((s) => [s.id, { present: s.present, action: s.action }])),
        });
      }

      const missing = plan.filter((s) => !s.present);
      if (missing.length === 0) {
        ui.success('\nEverything is installed. Run `traceback doctor` to confirm the full setup.');
        return;
      }

      if (options.check) {
        ui.info(`\n${missing.length} tool${missing.length > 1 ? 's' : ''} missing — re-run without ` +
          '`--check` to install them.');
        return;
      }

      ui.info('');

      const installable = missing.filter((s) => s.action === 'install');
      if (installable.length > 0) {
        const msg = `Install ${installable.length} missing tool${installable.length > 1 ? 's' : ''} now?`;
        let proceed = options.yes;
        if (!proceed) {
          const { confirm } = await import('@inquirer/prompts');
          proceed = await confirm({ message: msg, default: true });
        }
        if (!proceed) {
          ui.hint('Skipped. Run `traceback install --yes` later, or install manually.');
        } else {
          for (const step of installable) {
            // The user already confirmed the batch — pass that through so nested
            // prompts (Appium's internal confirm) don't ask again.
            await installStep(ui, step, presence, proceed);
          }
        }
      }

      // Anything we can't automate: print guidance.
      const guided = missing.filter((s) => s.action === 'guidance');
      if (guided.length > 0) {
        ui.info('\nManual steps:');
        for (const step of guided) {
          ui.warn(`\n${step.label}:`);
          for (const line of step.guidance) ui.hint(`  ${line}`);
        }
      }

      ui.info('\nDone. Run `traceback doctor` any time to re-check your setup.');
      printEnvHints(ui);
    });
}

/** Probe the machine for each tool the plan cares about. */
function detectPresence(): ToolPresence {
  return {
    brew: commandExists('brew'),
    node: commandExists('node'),
    npm: commandExists('npm'),
    appium: commandExists('appium'),
    java: javaPresent(),
    adb: commandExists('adb'),
    androidStudio: androidStudioPresent(),
    xcodeClt: process.platform === 'darwin' && commandExists('xcrun'),
    xcodeFull: process.platform === 'darwin' && commandExists('xcodebuild'),
    flutter: commandExists('flutter'),
  };
}

function javaPresent(): boolean {
  try {
    execSync('java -version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function androidStudioPresent(): boolean {
  if (process.env['ANDROID_HOME'] || process.env['ANDROID_SDK_ROOT']) return true;
  if (commandExists('sdkmanager')) return true;
  if (process.platform === 'darwin') {
    return existsSync('/Applications/Android Studio.app');
  }
  return false;
}

/** For brew-driven steps, make sure Homebrew actually exists (it may have been skipped,
 * or its own install may have failed) — otherwise print the manual alternatives instead of
 * failing with a bare `brew: command not found`. Returns true when install can proceed. */
function brewAvailableOrExplain(ui: UIService, step: InstallStep): boolean {
  if (commandExists('brew')) return true;
  ui.warn(`${step.label} — Homebrew is not available, so this cannot be auto-installed:`);
  for (const line of step.guidance) ui.hint(`  ${line}`);
  return false;
}

async function installStep(
  ui: UIService,
  step: InstallStep,
  presence: ToolPresence,
  skipConfirm: boolean,
): Promise<void> {
  const id = step.id;
  ui.info(''); // breathing room between streamed installs
  switch (id) {
    case 'homebrew':
      ui.info('Installing Homebrew (may ask for your password, takes a few minutes)...');
      await runStreamed('/bin/bash', [
        '-c',
        'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash',
      ]);
      if (!commandExists('brew')) {
        ui.warn('Homebrew is still not on PATH — the installer may have been cancelled or failed.');
        ui.hint('  The remaining tools can be installed manually instead (see the steps below).');
      }
      break;
    case 'node':
      if (!brewAvailableOrExplain(ui, step)) break;
      ui.info('Installing Node.js via Homebrew...');
      await runStreamed('brew', ['install', 'node']);
      break;
    case 'appium':
      await ensureAppium(ui, skipConfirm);
      await ensureDrivers(ui, skipConfirm);
      break;
    case 'java':
      if (!brewAvailableOrExplain(ui, step)) break;
      ui.info('Installing Java 17 (Temurin) via Homebrew...');
      await runStreamed('brew', ['install', '--cask', 'temurin@17']);
      break;
    case 'android': {
      if (!brewAvailableOrExplain(ui, step)) break;
      if (!presence.adb) {
        ui.info('Installing Android platform-tools (adb)...');
        await runStreamed('brew', ['install', '--cask', 'android-platform-tools']);
      }
      if (!presence.androidStudio) {
        ui.info('Installing Android Studio (large download, may take a while)...');
        await runStreamed('brew', ['install', '--cask', 'android-studio']);
        ui.hint('After first launch of Android Studio, accept the SDK licenses and create an AVD:');
        ui.hint('  sdkmanager --licenses');
        ui.hint('  sdkmanager "emulator" "system-images;android-35;google_apis;arm64-v8a"');
      }
      break;
    }
    case 'ios': {
      // CLT only — full Xcode is an App Store install we never automate.
      ui.info('Opening the Command Line Tools installer (follow the system prompt)...');
      await runStreamed('xcode-select', ['--install']);
      // The installer is a GUI flow and may not finish synchronously — be honest
      // about the result instead of claiming success.
      if (!commandExists('xcrun')) {
        ui.warn('Command Line Tools are still not on PATH — the installer may still be running.');
      }
      ui.hint('For iOS simulators you also need full Xcode from the Mac App Store:');
      ui.hint('  sudo xcodebuild -license accept');
      break;
    }
    case 'flutter':
      if (!brewAvailableOrExplain(ui, step)) break;
      ui.info('Installing the Flutter SDK via Homebrew (large download)...');
      await runStreamed('brew', ['install', '--cask', 'flutter']);
      ui.hint('Run `flutter doctor` to finish the Flutter toolchain setup.');
      break;
  }
}

/** If Homebrew lives outside PATH, tell the user — otherwise the fresh tools are invisible. */
function printEnvHints(ui: UIService): void {
  if (process.platform !== 'darwin') return;
  const brewBins = ['/opt/homebrew/bin', '/usr/local/bin'];
  const path = process.env['PATH'] ?? '';
  if (brewBins.some((dir) => !path.includes(dir))) {
    ui.hint('');
    ui.hint('If new tools are not found, add Homebrew to your PATH in ~/.zshrc:');
    ui.hint('  echo \'eval "$(/opt/homebrew/bin/brew shellenv)"\' >> ~/.zshrc');
  }
}
