# Changelog

All notable changes to `@tracebackai/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-09-18

### Added

- MCP server command (`traceback mcp`) for AI agent integrations (Claude Code, Cursor, Codex).
- Interactive mobile verification support (`traceback mobile verify`) with local Appium relay.
- Device picker for Android emulators and iOS simulators.
- Interactive live streaming for cloud-based browser and mobile test executions.
- Shell completion generator for bash, zsh, fish, and powershell (`traceback completion`).
- Diagnostics and system health check (`traceback doctor`).
- Automated configuration management (`traceback config`).

### Changed

- Improved error formatting and debug output logs.
- Optimized bundle size and ESM/CJS dual-build output with `tsup`.

## [1.0.0] - 2026-09-01

### Added

- Initial production release of Traceback CLI.
- Browser-based authentication flow (`traceback login`).
- Workspace and project navigation commands (`traceback workspaces`, `traceback project`).
- Interactive test execution and results viewer (`traceback tests`).
