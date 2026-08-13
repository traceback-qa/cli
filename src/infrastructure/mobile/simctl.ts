/**
 * simctl resolution for iOS tooling.
 *
 * The trap: `xcrun simctl` only works when the ACTIVE developer directory is a real
 * Xcode. Many machines (and CI images) have Xcode installed at
 * `/Applications/Xcode.app` but `xcode-select -p` pointing at the Command Line Tools
 * (which has NO simctl) — e.g. after a CLT install or an Xcode update. On those
 * machines `xcrun simctl` dies with "unable to find utility simctl", silently killing
 * iOS device detection.
 *
 * These helpers bypass `xcrun` entirely: they resolve the ABSOLUTE path to the simctl
 * binary inside an actual Xcode (xcode-select output when it's a real Xcode,
 * `DEVELOPER_DIR`, the standard /Applications locations), which works no matter what
 * `xcode-select` points at. Shared by the device detector and the native-rebuild
 * runner.
 */

import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

/**
 * Ordered candidate absolute paths to the simctl binary.
 *
 * Pure + injectable so it can be unit-tested: pass the `xcode-select -p` output (or
 * null), a home dir, and the DEVELOPER_DIR value.
 */
export function simctlCandidatePaths(
  selectOutput: string | null,
  home: string = os.homedir(),
  devDirEnv: string | undefined = process.env['DEVELOPER_DIR'],
): string[] {
  // Command Line Tools has no simctl — skip that xcode-select output so we don't
  // waste an existsSync on a path that can never resolve.
  const isCommandLineTools =
    selectOutput?.includes('CommandLineTools') || selectOutput?.includes('Command Line Tools');
  const fromSelect =
    selectOutput && !isCommandLineTools ? path.join(selectOutput, 'usr', 'bin', 'simctl') : null;

  // DEVELOPER_DIR is the explicit override in xcrun semantics, so it wins over
  // whatever xcode-select resolves to.
  const candidates = [
    devDirEnv ? path.join(devDirEnv, 'usr', 'bin', 'simctl') : null,
    fromSelect,
    '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl',
    path.join(home, 'Applications', 'Xcode.app', 'Contents', 'Developer', 'usr', 'bin', 'simctl'),
    '/Applications/Xcode-beta.app/Contents/Developer/usr/bin/simctl',
  ].filter((candidate): candidate is string => !!candidate);

  return [...new Set(candidates)];
}

/** Resolve the current xcode-select -p output (trimmed), or null. */
function xcodeSelectOutput(): string | null {
  try {
    const out = execSync('xcode-select -p', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Sync absolute path to simctl, or null when no usable Xcode is installed. */
export function resolveSimctlPathSync(): string | null {
  const selectOutput = xcodeSelectOutput();
  for (const candidate of simctlCandidatePaths(selectOutput)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Async absolute path to simctl, or null when no usable Xcode is installed. */
export async function resolveSimctlPath(): Promise<string | null> {
  let selectOutput: string | null = null;
  try {
    const { stdout } = await execFileP('xcode-select', ['-p'], { timeout: 10_000 });
    selectOutput = stdout.trim() || null;
  } catch {
    // xcode-select unavailable — fall through to the static candidates
  }
  for (const candidate of simctlCandidatePaths(selectOutput)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** UDID of the first booted iOS simulator, or null. */
export async function detectBootedSimulator(): Promise<string | null> {
  const simctl = await resolveSimctlPath();
  if (!simctl) return null;
  try {
    const { stdout } = await execFileP(simctl, ['list', 'devices', 'booted'], {
      timeout: 15_000,
    });
    const match =
      /\(([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\)\s*\(Booted\)/.exec(
        stdout,
      );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
