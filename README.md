# Traceback CLI

[![npm version](https://img.shields.io/npm/v/%40tracebackai%2Fcli.svg)](https://www.npmjs.com/package/@tracebackai/cli)
[![license](https://img.shields.io/npm/l/%40tracebackai%2Fcli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/%40tracebackai%2Fcli.svg)](https://nodejs.org)

Run and watch [Traceback](https://docs.traceback.dev) AI browser/mobile tests from your terminal —
browse your workspace's test library, kick off a run, and stream its progress live without
leaving the CLI.

```
$ traceback tests
✔ What type of tests?  🌐  Web tests
✔ Select a web test    SauceDemo  —  Login with hello@mail.com and the password tyler
  Environment: production
? Watch this run live? Yes
✔ Run started: 019fcef5-32d9-7b06-adc0-2af93b33a46f
ℹ Step 1: Navigate → https://www.saucedemo.com/
ℹ Step 2: Type → #user-name
ℹ Step 3: Click → #login-button
✔ Run completed: PASSED
```

## Install

```sh
npm install -g @tracebackai/cli
```

Requires Node.js 18 or later.

## Quick start

```sh
traceback login          # opens your browser to authenticate
traceback workspaces     # pick which workspace this CLI talks to
traceback tests          # browse and run a test, live
```

## What it does

- **Run tests from the terminal.** `traceback tests` walks you through picking a web or mobile
  test, resolves its environment automatically, and starts a cloud run — with the option to
  stream step-by-step progress (navigation, clicks, detected issues, pass/fail) as it happens.
- **Mobile verification against a real device.** `traceback mobile verify` drives the Traceback
  agent against a connected Android emulator or iOS simulator via Appium, using a natural-language
  goal instead of a hand-written test script.
- **Workspace, project, and agent management** without opening the dashboard —
  `traceback workspaces`, `traceback project`, `traceback agent`.
- **MCP server.** `traceback mcp` exposes Traceback as a tool source for MCP-compatible AI
  clients (Claude Code, Cursor, etc.), so an agent can trigger and inspect test runs on your
  behalf.
- **Scriptable output.** Every command supports `--json` for piping into other tools, plus
  `--ci` for non-interactive environments and `--silent`/`--debug` for controlling verbosity.

## Commands

| Command | Description |
| --- | --- |
| `traceback login` (alias `signin`) | Authenticate via browser |
| `traceback auth login\|logout\|status\|whoami` | Manage authentication |
| `traceback workspaces` | Select the active workspace |
| `traceback tests` | Browse and run a web or mobile test, with live streaming |
| `traceback mobile verify` | Verify a mobile app against a natural-language goal on a connected device/emulator |
| `traceback setup` | Install Appium and the drivers `mobile verify` needs |
| `traceback project list\|get\|delete` | Manage projects |
| `traceback agent list` | List agents |
| `traceback config get\|set\|list\|reset` | Manage local CLI configuration |
| `traceback doctor` | Diagnose your local Traceback setup |
| `traceback mcp` | Start the MCP server for AI agent integrations |
| `traceback completion [shell]` | Print a shell completion script (bash, zsh, fish, powershell) |
| `traceback update` | Check for a newer CLI version |

Run `traceback <command> --help` for a command's full options.

### `traceback mobile verify`

```sh
traceback mobile verify \
  --goal "Log in and add the first item to the cart" \
  --platform android \
  --device emulator-5554
```

The backend agent runs in the cloud; the CLI relays screen state and executes the returned
gestures locally via [Appium](https://appium.io), so you need an Appium server running
(`appium`) and a device or emulator already booted. First time setting this up? Run
`traceback setup` to install Appium and its Android/iOS drivers.

| Flag | Description |
| --- | --- |
| `-g, --goal <text>` | Natural-language verification goal (required) |
| `-p, --platform <platform>` | `android` or `ios` (required) |
| `--device <name>` | Device/emulator name |
| `--apk <path>` / `--app <path>` | App package to install (Android / iOS) |
| `--package <pkg>` / `--activity <activity>` | Android launch target |
| `--deep-link <uri>` | Deep link to open on start |
| `--appium-url <url>` | Appium server URL (default `http://localhost:4723`) |
| `--workspace <id>` | Workspace ID (defaults to the active one) |

## Global flags

Available on every command:

| Flag | Description |
| --- | --- |
| `--json` | Output machine-readable JSON instead of formatted text |
| `--ci` | Non-interactive mode — no prompts or spinners |
| `--silent` | Suppress all output |
| `--debug` | Verbose debug logging |
| `--no-color` | Disable colored output |

## Configuration

The CLI stores its config in your OS's standard app-data directory (override with
`TRACEBACK_CONFIG_DIR`). Everything can also be set via environment variable:

| Variable | Description | Default |
| --- | --- | --- |
| `TRACEBACK_API_URL` | Backend API base URL | `http://localhost:8000` |
| `TRACEBACK_ENVIRONMENT` | Default test-run environment | `production` |
| `TRACEBACK_TELEMETRY_OFF` | Opt out of anonymous usage telemetry | `false` |
| `TRACEBACK_CONFIG_DIR` | Override the config directory | OS default |
| `TRACEBACK_LOG_DIR` | Override the logs directory | OS default |
| `TRACEBACK_CI` | Force non-interactive mode | unset |

Or inspect/change persisted config directly:

```sh
traceback config list
traceback config set <key> <value>
```

## Troubleshooting

```sh
traceback doctor
```

Checks your authentication, network connectivity, and local environment, and suggests fixes for
anything it finds.

## License

MIT
