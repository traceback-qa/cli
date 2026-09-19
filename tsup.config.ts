import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
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
    TRACEBACK_VERSION: pkg.version,
    TRACEBACK_BUILD_TIME: new Date().toISOString(),
  },
});
