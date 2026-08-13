import type { Command } from 'commander';
import type { CliContext } from '../../types/context.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';
import { registerMobileDevCommands } from './dev.js';
import { resolveVerifyDevice } from '../../infrastructure/mobile/device.picker.js';
import { runMobileVerify, DEFAULT_APPIUM_URL } from './verify.js';

type ContextGetter = (cmd: Command) => CliContext | undefined;

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
        'The CLI opens a persistent Socket.IO bridge to the backend agent,\n' +
        'which observes and controls the selected device through Appium.',
    )
    .requiredOption('-g, --goal <text>', 'Natural-language verification goal')
    .requiredOption('-p, --platform <platform>', 'Platform: android or ios')
    .option('--apk <path>', 'Path to APK (Android)')
    .option('--app <path>', 'Path to .app bundle (iOS)')
    .option(
      '--device <id>',
      'Device/emulator to target (serial or name; auto-detected, or prompted when ambiguous)',
    )
    .option('--os-version <version>', 'OS version to target')
    .option('--package <pkg>', 'Android app package (e.g. com.example.app)')
    .option('--activity <activity>', 'Android launch activity')
    .option('--deep-link <uri>', 'Deep link to navigate to on start')
    .option('--appium-url <url>', 'Appium server URL', DEFAULT_APPIUM_URL)
    .option('--workspace <id>', 'Workspace ID (defaults to current)')
    .option(
      '--vision',
      'Experimental: skip the accessibility tree entirely and target the screen by raw pixel ' +
        'coordinates instead of numbered elements. Use when /source is slow or unreliable on ' +
        'the target screen (e.g. a native map view).',
      false,
    )
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      const ui = ctx.infra.ui;

      // ── Resolve workspace ──────────────────────────────
      // `activeWorkspaceId` was never part of CliContext's declared shape -- this always read
      // undefined, so `--workspace` was silently the only way to select a workspace and every
      // run without it hit the error below. `tests`'s equivalent resolution
      // (`ctx.infra.config.loadGlobalConfig().workspaceId`) is the actual established pattern.
      let workspaceId = options['workspace'];
      if (!workspaceId) {
        const config = await ctx.infra.config.loadGlobalConfig();
        workspaceId = config.workspaceId;
        if (!workspaceId) {
          ui.error(
            'No workspace selected. Use --workspace <id> or:\n  traceback workspaces select',
          );
          return;
        }
      }

      // ── Resolve the device the test runs against ────────
      if (options['platform'] !== 'android' && options['platform'] !== 'ios') {
        ui.error(`Unsupported platform: ${options['platform']} — use android or ios`);
        return;
      }
      const platform = options['platform'] as 'android' | 'ios';
      const device = await resolveVerifyDevice({
        platform,
        explicitId: options['device'] ?? undefined,
        flagName: '--device',
        interactive: !ui.isJsonMode() && !ui.isSilent(),
        ui,
      });
      if (!device) return;

      // ── Run the verify loop (shared with `traceback tests` live-verify) ──
      await runMobileVerify(ctx, {
        workspaceId,
        goal: options['goal'],
        platform,
        device,
        appiumUrl: options['appiumUrl'],
        appPath: options['apk'] || options['app'],
        osVersion: options['osVersion'],
        appPackage: options['package'],
        appActivity: options['activity'],
        deepLink: options['deepLink'],
        visionMode: Boolean(options['vision']),
      });
    });
}
