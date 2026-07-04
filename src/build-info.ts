export const BUILD_INFO = {
  version: process.env.TRACEBACK_VERSION ?? '0.0.0-development',
  buildTime: process.env.TRACEBACK_BUILD_TIME ?? new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
};
