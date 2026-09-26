/**
 * Init command — interactive project onboarding and spec scaffolding wizard.
 *
 * Scaffolds a clean `qa/` directory structure:
 * - `qa/surface.yaml` (inferred project name, base URL patterns for preview/prod/local, ignore paths)
 * - `qa/policy.yaml` (merge.block_on sacred, heal policies)
 * - `qa/clauses/sample.md` (sample clause with YAML frontmatter & #sacred)
 * - `qa/journeys/smoke.yaml` (sample smoke journey covering the clause)
 *
 * Also configures `traceback.config.json`, MCP servers, and agent skills.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import type { CliContext } from '../../types/context.js';
import { SpecService } from '../../services/spec/index.js';

type ContextGetter = typeof GetContextFn;

interface InitOptions {
  yes?: boolean;
  workspace?: string;
  agent?: string;
  mcp?: boolean;
  skills?: boolean;
  force?: boolean;
}

interface WorkspaceItem {
  id: string;
  name: string;
  slug?: string;
}

export function registerInitCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('init')
    .description('Initialize Traceback QA and scaffold spec directory (qa/) in your repository')
    .option('-y, --yes', 'Accept detected defaults without prompting', false)
    .option('-w, --workspace <id>', 'Traceback workspace ID to link')
    .option('-f, --force', 'Overwrite existing qa/ files if they exist', false)
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
  const specService = new SpecService();

  ui.treeStart(
    'Traceback QA Specification & Project Setup',
    'Scaffolding spec-driven quality plane in repository',
  );

  // ── Step 1: Detect Project Framework & Stack ─────────────────
  const detection = specService.detectFramework(projectRoot);
  ui.treeStep(
    1,
    `Project: ${chalk.bold.white(detection.suggestedName)} (${chalk.cyan(detection.framework)}) → Default URL: ${chalk.dim(detection.defaultBaseUrl)}`,
    'success',
  );

  // ── Step 2: Scaffold qa/ Directory Hierarchy ─────────────────
  const createdFiles = specService.scaffoldQa(projectRoot, {
    framework: detection.framework,
    name: detection.suggestedName,
    baseUrl: detection.defaultBaseUrl,
    force: options.force,
  });

  ui.treeStep(
    2,
    `Scaffolded QA specification hierarchy (${chalk.bold('qa/')})`,
    'success',
  );
  for (const f of createdFiles) {
    ui.hint(`Created ${chalk.green(path.relative(projectRoot, f))}`);
  }

  // ── Step 3: Authentication & Workspace Context ───────────────
  let isAuth = await ctx.infra.auth.isAuthenticated();
  if (!isAuth) {
    if (ctx.flags.ci || options.yes) {
      ui.treeStep(3, 'Authentication: Skipped (CI / Non-interactive mode)', 'info');
    } else {
      ui.treeStep(3, 'Authentication: Not logged in', 'running');
      const { confirm } = await import('@inquirer/prompts');
      const loginNow = await confirm({
        message: 'You are not logged in. Log in with your browser now?',
        default: true,
      });

      if (loginNow) {
        const loginSpinner = ui.spinner('Opening browser for authentication...');
        try {
          await ctx.infra.auth.loginWithBrowser();
          loginSpinner.succeed('Authentication successful');
          isAuth = true;
        } catch {
          loginSpinner.fail('Authentication failed');
        }
      }
    }
  }

  let selectedWorkspaceId = options.workspace;
  if (isAuth) {
    const account = await ctx.infra.auth.getCurrentAccount();
    const userDisplay = account?.email || account?.accountId || 'Authenticated';
    ui.treeStep(3, `Authenticated as ${chalk.bold.white(userDisplay)}`, 'success');

    const globalConfig = await ctx.infra.config.loadGlobalConfig();
    if (!selectedWorkspaceId) {
      selectedWorkspaceId = globalConfig.workspaceId;
    }

    if (!selectedWorkspaceId && !options.yes && !ctx.flags.ci) {
      try {
        const res = await ctx.infra.api.get<WorkspaceItem[]>('/api/v1/workspaces');
        const workspaces = res.data || [];
        if (workspaces.length > 0) {
          const { select } = await import('@inquirer/prompts');
          selectedWorkspaceId = await select({
            message: 'Select the Traceback workspace for this project:',
            choices: workspaces.map((w) => ({
              name: `${chalk.bold(w.name)} ${chalk.dim(`(${w.id})`)}`,
              value: w.id,
            })),
            default: workspaces[0]?.id,
          });
        }
      } catch {
        // Skip interactive prompt on error
      }
    }
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
        try {
          await initSub.parseAsync(['node', 'traceback', 'skills', 'init', '-y']);
          ui.treeStep(5, `Installed AI skills in ${chalk.bold('.traceback/skills/')}`, 'success');
        } catch {
          ui.treeStep(5, 'AI skills ready', 'info');
        }
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

  ui.treeEnd('Traceback QA successfully initialized!', true);

  // ── Step 7: Next Steps Action Box ────────────────────────────
  ui.emptyState(
    '🚀 Your project is ready for Spec-Driven QA!',
    'Run any of the following commands to get started:',
    [
      { label: 'Verify local specs', command: 'traceback verify' },
      { label: 'Explore & discover routes', command: 'traceback explore http://localhost:3000' },
      { label: 'Check spec alignment on PR', command: 'traceback align' },
      { label: 'Start MCP server for agents', command: 'traceback mcp' },
    ],
  );
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

  // 2. Claude Code MCP (.claude/mcp.json)
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
