/**
 * WebDriverAgent (WDA) pre-build — shared by `traceback setup` (which triggers the build) and
 * `appium.bridge.ts` (which checks whether one exists and wires it into real sessions).
 *
 * WDA is the on-device automation app Appium's XCUITest driver actually talks to; the driver
 * compiles and installs it via a real `xcodebuild build-for-testing` the first time it's needed
 * against a given simulator, which can take several minutes and — with nothing on screen to show
 * for it — looks indistinguishable from a hang (see the incident noted in appium.bridge.ts).
 *
 * Appium's own `usePrebuiltWDA` + `derivedDataPath` capabilities are the documented way around
 * this: build once via `xcodebuild build-for-testing -derivedDataPath <path>`, then point every
 * later session at that same `derivedDataPath` — the driver runs `test-without-building` against
 * whichever simulator the real session actually targets instead of recompiling, which is why the
 * build destination used here doesn't need to match later runs' destinations.
 *
 * Kept in its own module (not inlined in either caller) so the path/filename constants that
 * define what "already pre-built" means can't drift apart between the two call sites.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { getDataDir } from '../../platform/paths.js';

/** Where Appium keeps its installed drivers — same default Appium itself uses, overridable the
 * same way (`APPIUM_HOME`). */
export function appiumHome(): string {
  return process.env.APPIUM_HOME || path.join(os.homedir(), '.appium');
}

/** The WebDriverAgent Xcode project bundled inside the installed xcuitest driver. Null if the
 * driver isn't installed at all — there's nothing to build. */
export function wdaProjectPath(): string | null {
  const candidate = path.join(
    appiumHome(),
    'node_modules',
    'appium-xcuitest-driver',
    'node_modules',
    'appium-webdriveragent',
    'WebDriverAgent.xcodeproj',
  );
  return fs.existsSync(candidate) ? candidate : null;
}

/** Fixed, not configurable — both callers need to agree on exactly one location. */
export function wdaDerivedDataPath(): string {
  return path.join(getDataDir(), 'wda-derived-data');
}

/** The actual compiled app bundle a successful `build-for-testing` produces — checking for this
 * specific file (not just the derived-data directory existing) is what tells a half-finished or
 * failed build apart from a real, usable one. Name/path are exactly what
 * appium-webdriveragent's own build script (Scripts/build-webdriveragent.mjs) produces and
 * expects, not guessed. */
export function wdaPrebuiltAppPath(): string {
  return path.join(
    wdaDerivedDataPath(),
    'Build',
    'Products',
    'Debug-iphonesimulator',
    'WebDriverAgentRunner-Runner.app',
  );
}

export function wdaIsPrebuilt(): boolean {
  return fs.existsSync(wdaPrebuiltAppPath());
}
