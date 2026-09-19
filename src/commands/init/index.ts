/**
 * Init command — interactive project onboarding and AI agent setup wizard.
 *
 * Scans the local repository, resolves authentication & workspace context,
 * generates `traceback.config.json`, installs agent skills, and configures MCP servers.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import type { CliContext } from '../../types/context.js';

type ContextGetter = typeof GetContextFn;

interface ProjectDetection {
  framework: string;
  platform: 'web' | 'mobile' | 'universal';
  suggestedName: string;
}

interface InitOptions {
  yes?: boolean;
  workspace?: string;
  agent?: string;
  mcp?: boolean;
  skills?: boolean;
}

interface WorkspaceItem {
  id: string;
  name: string;
  slug?: string;
}

export function registerInitCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('init')
    .description('Initialize Traceback in your project repository (onboarding wizard)')
    .option('-y, --yes', 'Accept detected defaults without prompting', false)
    .option('-w, --workspace <id>', 'Traceback workspace ID to link')
    .option('-a, --agent <agent>', 'AI agent: cursor, claude, opencode, codex, all, none', 'auto')
    .option('--no-mcp', 'Skip MCP server configuration')
    .option('--no-skills', 'Skip AI agent skills installation')
    .action(async function (this: Command, options: InitOptions) {
      const ctx = getContext(this);
      if (!ctx) return;
      await runInitWizard(ctx, program, options);
    });
}

async function runInitWizard(
  ctx: CliContext,
  program: Command,
  options: InitOptions,
): Promise<void> {
  const ui = ctx.infra.ui;
  const projectRoot = process.cwd();

  ui.treeStart(
    'Traceback Project Initialization',
    'Connecting repository to Traceback AI platform',
  );

  // ── Step 1: Detect Project Framework & Platform ──────────────
  const detection = detectProject(projectRoot);
  ui.treeStep(
    1,
    `Project: ${chalk.bold.white(detection.suggestedName)} (${chalk.cyan(detection.framework)})`,
    'success',
  );

  // ── Step 2: Authentication Check ─────────────────────────────
  let isAuth = await ctx.infra.auth.isAuthenticated();
  if (!isAuth) {
    ui.treeStep(2, 'Authentication: Not logged in', 'running');
    if (ctx.flags.ci || (options.yes && !isAuth)) {
      ui.error('Authentication required. Run `traceback login` first.');
      return;
    }

    const { confirm } = await import('@inquirer/prompts');
    const loginNow = await confirm({
      message: 'You are not logged in. Log in with your browser now?',
      default: true,
    });

    if (!loginNow) {
      ui.warn('Initialization aborted. Run `traceback login` and try again.');
      return;
    }

    const loginSpinner = ui.spinner('Opening browser for authentication...');
    try {
      await ctx.infra.auth.loginWithBrowser();
      loginSpinner.succeed('Authentication successful');
      isAuth = true;
    } catch {
      loginSpinner.fail('Authentication failed');
      ui.error('Could not authenticate. Please try `traceback login`.');
      return;
    }
  }

  const account = await ctx.infra.auth.getCurrentAccount();
  const userDisplay = account?.email || account?.accountId || 'Authenticated';
  ui.treeStep(2, `Authenticated as ${chalk.bold.white(userDisplay)}`, 'success');

  // ── Step 3: Workspace Linking ────────────────────────────────
  let selectedWorkspaceId = options.workspace;
  const globalConfig = await ctx.infra.config.loadGlobalConfig();

  if (!selectedWorkspaceId) {
    selectedWorkspaceId = globalConfig.workspaceId;
  }

  if (!selectedWorkspaceId || (!options.yes && !ctx.flags.ci)) {
    const wsSpinner = ui.spinner('Fetching workspaces...');
    let workspaces: WorkspaceItem[] = [];
    try {
      const res = await ctx.infra.api.get<WorkspaceItem[]>('/api/v1/workspaces');
      workspaces = res.data || [];
      wsSpinner.stop();
    } catch {
      wsSpinner.fail('Could not fetch workspaces');
    }

    if (workspaces.length > 0) {
      if (options.yes && workspaces[0]) {
        selectedWorkspaceId = workspaces[0].id;
      } else if (!ctx.flags.ci) {
        const { select } = await import('@inquirer/prompts');
        selectedWorkspaceId = await select({
          message: 'Select the Traceback workspace for this project:',
          choices: workspaces.map((w) => ({
            name: `${chalk.bold(w.name)} ${chalk.dim(`(${w.id})`)}`,
            value: w.id,
          })),
          default: selectedWorkspaceId || workspaces[0]?.id,
        });
      }
    }
  }

  if (selectedWorkspaceId) {
    ui.treeStep(3, `Linked Workspace: ${chalk.bold.cyan(selectedWorkspaceId)}`, 'success');
  } else {
    ui.treeStep(
      3,
      'No workspace selected (can be linked later via `traceback workspaces`)',
      'info',
    );
  }

  // ── Step 4: Write Project Config (`traceback.config.json`) ────
  const configPath = path.join(projectRoot, 'traceback.config.json');
  const projectConfigContent = {
    $schema: 'https://docs.traceback.dev/schemas/config.json',
    name: detection.suggestedName,
    platform: detection.platform,
    framework: detection.framework,
    workspaceId: selectedWorkspaceId || undefined,
    environment: 'production',
  };

  fs.writeFileSync(configPath, JSON.stringify(projectConfigContent, null, 2) + '\n', 'utf8');
  ui.treeStep(4, `Created ${chalk.bold('traceback.config.json')}`, 'success');

  // ── Step 5: Install AI Agent Skills ──────────────────────────
  if (options.skills !== false) {
    const skillsCmd = program.commands.find((c) => c.name() === 'skills');
    if (skillsCmd) {
      const initSub = skillsCmd.commands.find((c) => c.name() === 'init');
      if (initSub) {
        await initSub.parseAsync(['node', 'traceback', 'skills', 'init', '-y']);
        ui.treeStep(5, `Installed AI skills in ${chalk.bold('.traceback/skills/')}`, 'success');
      }
    }
  }

  // ── Step 6: Configure MCP Integration (Cursor / Claude) ──────
  if (options.mcp !== false) {
    const configuredMcp = configureMcpServers(projectRoot);
    if (configuredMcp.length > 0) {
      ui.treeStep(
        6,
        `Configured MCP server for: ${chalk.bold.white(configuredMcp.join(', '))}`,
        'success',
      );
    } else {
      ui.treeStep(6, 'MCP integration ready (use `traceback mcp`)', 'info');
    }
  }

  ui.treeEnd('Traceback successfully initialized!', true);

  // ── Step 7: Next Steps Action Box ────────────────────────────
  ui.emptyState(
    '🚀 Your project is ready for AI test automation!',
    'Run any of the following commands to get started:',
    [
      { label: 'Browse & run tests', command: 'traceback tests' },
      {
        label: 'Mobile verification',
        command: 'traceback mobile verify --goal "Log in and check feed"',
      },
      { label: 'Environment check', command: 'traceback doctor' },
      { label: 'Start MCP server', command: 'traceback mcp' },
    ],
  );
}

function detectProject(projectRoot: string): ProjectDetection {
  let framework = 'Generic Web / Mobile';
  let platform: 'web' | 'mobile' | 'universal' = 'web';
  let suggestedName = path.basename(projectRoot);

  const pkgJsonPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.name) suggestedName = pkg.name;

      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next']) {
        framework = 'Next.js';
        platform = 'web';
      } else if (deps['expo']) {
        framework = 'Expo (React Native)';
        platform = 'universal';
      } else if (deps['react-native']) {
        framework = 'React Native';
        platform = 'mobile';
      } else if (deps['vite']) {
        framework = 'Vite';
        platform = 'web';
      } else if (deps['@remix-run/react']) {
        framework = 'Remix';
        platform = 'web';
      } else if (deps['nuxt'] || deps['vue']) {
        framework = 'Vue / Nuxt';
        platform = 'web';
      } else if (deps['svelte'] || deps['@sveltejs/kit']) {
        framework = 'SvelteKit';
        platform = 'web';
      } else if (deps['react']) {
        framework = 'React';
        platform = 'web';
      }
    } catch {
      // Ignore parse errors
    }
  } else if (fs.existsSync(path.join(projectRoot, 'pubspec.yaml'))) {
    framework = 'Flutter';
    platform = 'universal';
  } else if (
    fs.existsSync(path.join(projectRoot, 'Podfile')) ||
    fs.existsSync(path.join(projectRoot, 'ios'))
  ) {
    framework = 'iOS Native';
    platform = 'mobile';
  } else if (
    fs.existsSync(path.join(projectRoot, 'build.gradle')) ||
    fs.existsSync(path.join(projectRoot, 'android'))
  ) {
    framework = 'Android Native';
    platform = 'mobile';
  }

  return { framework, platform, suggestedName };
}

function configureMcpServers(projectRoot: string): string[] {
  const configured: string[] = [];

  // 1. Cursor MCP (.cursor/mcp.json)
  const cursorDir = path.join(projectRoot, '.cursor');
  if (fs.existsSync(cursorDir) || fs.existsSync(path.join(osHomedir(), '.cursor'))) {
    try {
      fs.mkdirSync(cursorDir, { recursive: true });
      const mcpPath = path.join(cursorDir, 'mcp.json');
      let currentConfig: { mcpServers?: Record<string, unknown> } = {};
      if (fs.existsSync(mcpPath)) {
        currentConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      }
      currentConfig.mcpServers = {
        ...(currentConfig.mcpServers || {}),
        traceback: {
          command: 'traceback',
          args: ['mcp'],
        },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(currentConfig, null, 2) + '\n', 'utf8');
      configured.push('Cursor (.cursor/mcp.json)');
    } catch {
      // Ignore write errors
    }
  }

  // 2. Claude Code MCP (.claude/mcp.json or root claude.json)
  const claudeDir = path.join(projectRoot, '.claude');
  if (fs.existsSync(claudeDir) || fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))) {
    try {
      fs.mkdirSync(claudeDir, { recursive: true });
      const mcpPath = path.join(claudeDir, 'mcp.json');
      let currentConfig: { mcpServers?: Record<string, unknown> } = {};
      if (fs.existsSync(mcpPath)) {
        currentConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      }
      currentConfig.mcpServers = {
        ...(currentConfig.mcpServers || {}),
        traceback: {
          command: 'traceback',
          args: ['mcp'],
        },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(currentConfig, null, 2) + '\n', 'utf8');
      configured.push('Claude Code (.claude/mcp.json)');
    } catch {
      // Ignore write errors
    }
  }

  return configured;
}

function osHomedir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}
