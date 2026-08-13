/**
 * Tool plan for `traceback install` — pure logic, no side effects, unit-testable.
 *
 * Given what the host machine already has, produce an ordered list of steps the
 * install command will take, from "already present" through "will install" to
 * "manual guidance needed". The executor (index.ts) reads `present` + `action`
 * and does the actual installs with confirmation.
 */

export type ToolId =
  | 'homebrew'
  | 'node'
  | 'appium'
  | 'java'
  | 'android'
  | 'ios'
  | 'flutter';

export interface InstallStep {
  id: ToolId;
  /** Short label shown in the status table. */
  label: string;
  /** Rough download size, when the install is big — shown before confirming. */
  size?: string;
  /** Whether this tool is required for the core mobile flow (vs optional extras). */
  required: boolean;
  /** macOS-only step (brew cask / Xcode). On other platforms it becomes guidance. */
  macOnly: boolean;
  /** Is the tool already usable on this machine? */
  present: boolean;
  /** 'install' = we can kick it off here; 'guidance' = print instructions instead. */
  action: 'install' | 'guidance';
  /** Exact command we would run (display only — the executor builds its own). */
  installHint?: string;
  /** Human instructions shown for guidance-only steps or failed installs. */
  guidance: string[];
}

/** Snapshot of the host's tooling, produced by the executor's detection phase. */
export interface ToolPresence {
  brew: boolean;
  node: boolean;
  npm: boolean;
  appium: boolean;
  java: boolean;
  adb: boolean;
  androidStudio: boolean;
  xcodeClt: boolean;
  xcodeFull: boolean;
  flutter: boolean;
}

export const TOOL_ORDER: ToolId[] = [
  'homebrew',
  'node',
  'appium',
  'java',
  'android',
  'ios',
  'flutter',
];

interface ToolMeta {
  id: ToolId;
  label: string;
  size?: string;
  required: boolean;
  macOnly: boolean;
  installHint: string;
  guidance: string[];
  /** Linux (apt) equivalent shown when the step can't auto-install on non-macOS. */
  aptHint?: string;
}

const TOOL_META: Record<ToolId, ToolMeta> = {
  homebrew: {
    id: 'homebrew',
    label: 'Homebrew (macOS package manager)',
    required: true,
    macOnly: true,
    installHint: 'https://brew.sh install script',
    guidance: [
      'Homebrew is required to install the other tools automatically.',
      'Install it manually: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    ],
  },
  node: {
    id: 'node',
    label: 'Node.js + npm (Appium runtime)',
    required: true,
    macOnly: false,
    installHint: 'brew install node',
    guidance: [
      'With Homebrew: brew install node',
      'Without Homebrew: install the Node.js LTS pkg from https://nodejs.org',
      'or via nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash',
    ],
    aptHint: 'sudo apt install -y nodejs npm',
  },
  appium: {
    id: 'appium',
    label: 'Appium + device drivers (uiautomator2, xcuitest)',
    required: true,
    macOnly: false,
    size: '~150 MB (drivers)',
    installHint: 'npm install -g appium && appium driver install uiautomator2 xcuitest',
    guidance: [
      'Run: npm install -g appium',
      'then: appium driver install uiautomator2',
      'and: appium driver install xcuitest',
    ],
  },
  java: {
    id: 'java',
    label: 'Java 17 (Android Gradle builds)',
    required: false,
    macOnly: true,
    size: '~180 MB',
    installHint: 'brew install --cask temurin@17',
    guidance: [
      'With Homebrew: brew install --cask temurin@17',
      'Without Homebrew: download the Temurin 17 .pkg from https://adoptium.net',
    ],
    aptHint: 'sudo apt install -y openjdk-17-jdk',
  },
  android: {
    id: 'android',
    label: 'Android tooling (adb + Android Studio SDK)',
    required: true,
    macOnly: true,
    size: '~1.2 GB',
    installHint: 'brew install --cask android-platform-tools android-studio',
    guidance: [
      'Install Android Studio from https://developer.android.com/studio',
      'or with Homebrew: brew install --cask android-studio',
      'Then accept SDK licenses and add an emulator image:',
      '  sdkmanager --licenses',
      '  sdkmanager "emulator" "system-images;android-35;google_apis;arm64-v8a"',
    ],
    aptHint: 'sudo apt install -y adb android-sdk-platform-tools',
  },
  ios: {
    id: 'ios',
    label: 'Xcode + Command Line Tools (iOS simulators)',
    required: false,
    macOnly: true,
    size: 'up to ~12 GB',
    installHint: 'xcode-select --install / Xcode from the App Store',
    guidance: [
      'Install Xcode from the Mac App Store, then accept the license:',
      '  sudo xcodebuild -license accept',
      'Command Line Tools only: xcode-select --install',
    ],
  },
  flutter: {
    id: 'flutter',
    label: 'Flutter SDK (only needed for Flutter projects)',
    required: false,
    macOnly: true,
    size: '~1 GB',
    installHint: 'brew install --cask flutter',
    guidance: [
      'With Homebrew: brew install --cask flutter',
      'Without Homebrew: unzip the SDK from https://docs.flutter.dev/get-started/install/macos',
      'then: flutter doctor',
    ],
    aptHint: 'sudo snap install flutter --classic (or use the tarball from flutter.dev)',
  },
};

export function buildInstallPlan(
  platform: NodeJS.Platform,
  p: ToolPresence,
  skip: string[] = [],
): InstallStep[] {
  const skipped = new Set(skip);
  const steps: InstallStep[] = [];

  for (const id of TOOL_ORDER) {
    if (skipped.has(id)) continue;
    const meta = TOOL_META[id];
    const present = presenceFor(id, p);

    if (platform !== 'darwin') {
      // Non-macOS: only pure-npm steps can auto-install here (the executor drives
      // brew on macOS and would fail on Linux). Everything else — including Node,
      // which this machine installs via apt — becomes guidance with an apt hint.
      const autoInstallable = id === 'appium';
      steps.push({
        id: meta.id,
        label: meta.label,
        size: meta.size,
        required: meta.required,
        macOnly: meta.macOnly,
        present,
        action: autoInstallable ? 'install' : 'guidance',
        installHint: meta.installHint,
        guidance: present
          ? []
          : autoInstallable
            ? meta.guidance
            : [...(meta.aptHint ? [meta.aptHint] : []), ...meta.guidance],
      });
      continue;
    }

    // macOS: decide install vs guidance per tool.
    let action: 'install' | 'guidance' = 'install';
    if (id === 'ios' && p.xcodeClt && !p.xcodeFull) {
      // CLT present but no full Xcode → the App Store step can't be automated.
      action = 'guidance';
    }
    steps.push({
      id: meta.id,
      label: meta.label,
      size: meta.size,
      required: meta.required,
      macOnly: meta.macOnly,
      present,
      action,
      installHint: meta.installHint,
      guidance: meta.guidance,
    });
  }
  return steps;
}

function presenceFor(id: ToolId, p: ToolPresence): boolean {
  switch (id) {
    case 'homebrew':
      return p.brew;
    case 'node':
      return p.node && p.npm;
    case 'appium':
      return p.appium;
    case 'java':
      return p.java;
    case 'android':
      return p.adb && p.androidStudio;
    case 'ios':
      return p.xcodeClt && p.xcodeFull;
    case 'flutter':
      return p.flutter;
  }
}
