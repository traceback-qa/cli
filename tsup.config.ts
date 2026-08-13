import { copyFile, mkdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  clean: true,
  target: 'node18',
  shims: true,
  platform: 'node',
  sourcemap: true,
  minify: false,
  treeshake: true,
  // scrcpy-server.jar (+ its LICENSE) is a binary asset the scrcpy capture agent adb-pushes to
  // the device at runtime — it isn't `import`-able TS/JS, so tsup just copies it next to the
  // bundle. Resolved at runtime via `import.meta.url` (see infrastructure/mobile/scrcpy-agent.ts).
  publicDir: 'assets/scrcpy',
  // flutter-vmshim.mjs is the Flutter hot-reload tunnel endpoint `mobile dev` spawns for
  // Topology-A sessions — same copy-next-to-the-bundle treatment. tsup's publicDir takes
  // one dir, so this ships the second asset explicitly after the build.
  onSuccess: async () => {
    await mkdir('dist', { recursive: true });
    await copyFile('assets/flutter/flutter-vmshim.mjs', 'dist/flutter-vmshim.mjs');
  },
  env: {
    TRACEBACK_BUILD_TIME: new Date().toISOString(),
  },
});
