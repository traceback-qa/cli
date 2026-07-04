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
  env: {
    TRACEBACK_BUILD_TIME: new Date().toISOString(),
  },
});
