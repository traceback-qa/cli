import type { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { getContext as GetContextFn } from '../../cli.js';
import type { UIService } from '../../infrastructure/ui/ui.types.js';

type ContextGetter = typeof GetContextFn;

export function registerCompletionCommands(program: Command, getContext: ContextGetter): void {
  const completion = program
    .command('completion')
    .description('Generate and install shell completion scripts (zsh, bash, fish)')
    .argument('[shell]', 'Shell type: zsh, bash, fish')
    .option('-i, --install', 'Automatically install completion hook into your shell profile')
    .option('-y, --yes', 'Skip confirmation prompt when installing')
    .action(async function (
      this: Command,
      shell: string | undefined,
      options: { install?: boolean; yes?: boolean },
    ) {
      const ctx = getContext(this);
      if (!ctx) return;

      const targetShell = (shell || detectShell()).toLowerCase();

      if (!['zsh', 'bash', 'fish'].includes(targetShell)) {
        ctx.infra.ui.error(
          `Unsupported shell: "${targetShell}". Supported shells: zsh, bash, fish.`,
        );
        return;
      }

      if (options.install) {
        await installShellCompletion(ctx, targetShell, options.yes ?? false);
        return;
      }

      if (!shell) {
        ctx.infra.ui.box(
          `${chalk.bold.hex('#6366F1')('🐚 Traceback Shell Completion Setup')}\n\n` +
            `To enable tab completion in ${chalk.bold.cyan(targetShell)}, run:\n\n` +
            getInstallInstruction(targetShell) +
            `\n\n${chalk.dim('Tip: Run `traceback completion --install` to automatically install it.')}`,
          { title: 'Shell Completion', borderColor: '#6366F1' },
        );
        return;
      }

      // Output raw completion script for eval
      const script = generateCompletionScript(targetShell);
      // eslint-disable-next-line no-console
      console.log(script);
    });

  completion
    .command('script <shell>')
    .description('Output raw completion script for a specific shell')
    .action(function (shell: string) {
      const targetShell = shell.toLowerCase();
      if (!['zsh', 'bash', 'fish'].includes(targetShell)) {
        // eslint-disable-next-line no-console
        console.error(`Unsupported shell: "${targetShell}". Supported shells: zsh, bash, fish.`);
        process.exit(1);
      }
      // eslint-disable-next-line no-console
      console.log(generateCompletionScript(targetShell));
    });
}

async function installShellCompletion(
  ctx: {
    infra: { ui: UIService };
    flags: { ci: boolean };
  },
  shell: string,
  skipPrompt: boolean,
): Promise<void> {
  const ui = ctx.infra.ui;
  const home = os.homedir();
  let rcPath = '';
  let evalLine = '';

  if (shell === 'zsh') {
    rcPath = path.join(home, '.zshrc');
    evalLine = 'eval "$(traceback completion zsh)"';
  } else if (shell === 'bash') {
    rcPath = path.join(home, '.bashrc');
    evalLine = 'eval "$(traceback completion bash)"';
  } else if (shell === 'fish') {
    const fishDir = path.join(home, '.config', 'fish', 'completions');
    fs.mkdirSync(fishDir, { recursive: true });
    const fishFile = path.join(fishDir, 'traceback.fish');
    fs.writeFileSync(fishFile, generateCompletionScript('fish'), 'utf8');
    ui.success(`Shell completion installed at ${fishFile}!`);
    ui.hint('Open a new fish terminal to start using tab completion.');
    return;
  }

  if (fs.existsSync(rcPath)) {
    const existing = fs.readFileSync(rcPath, 'utf8');
    if (existing.includes('traceback completion')) {
      ui.success(`Shell completion is already installed in ${rcPath}.`);
      return;
    }
  }

  if (!skipPrompt && !ctx.flags.ci) {
    const { confirm } = await import('@inquirer/prompts');
    const confirmed = await confirm({
      message: `Add Traceback completion hook to ${rcPath}?`,
      default: true,
    });
    if (!confirmed) {
      ui.hint('Installation cancelled.');
      return;
    }
  }

  const payload = `\n# Traceback CLI shell completion\n${evalLine}\n`;
  fs.appendFileSync(rcPath, payload, 'utf8');
  ui.success(`Shell completion added to ${rcPath}!`);
  ui.hint(`Run \`source ${rcPath}\` or restart your terminal to activate.`);
}

function detectShell(): string {
  const shellEnv = process.env.SHELL?.split('/').pop();
  if (shellEnv && ['zsh', 'bash', 'fish'].includes(shellEnv)) {
    return shellEnv;
  }
  return 'zsh';
}

function getInstallInstruction(shell: string): string {
  switch (shell) {
    case 'zsh':
      return (
        `  ${chalk.cyan('eval "$(traceback completion zsh)"')}\n\n` +
        `To persist, add it to your ${chalk.white('~/.zshrc')}:\n` +
        `  ${chalk.gray('echo \'eval "$(traceback completion zsh)"\' >> ~/.zshrc')}`
      );
    case 'bash':
      return (
        `  ${chalk.cyan('eval "$(traceback completion bash)"')}\n\n` +
        `To persist, add it to your ${chalk.white('~/.bashrc')}:\n` +
        `  ${chalk.gray('echo \'eval "$(traceback completion bash)"\' >> ~/.bashrc')}`
      );
    case 'fish':
      return (
        `  ${chalk.cyan('traceback completion script fish | source')}\n\n` +
        `To persist, save it to fish completions dir:\n` +
        `  ${chalk.gray('traceback completion script fish > ~/.config/fish/completions/traceback.fish')}`
      );
    default:
      return `  eval "$(traceback completion ${shell})"`;
  }
}

function generateCompletionScript(shell: string): string {
  switch (shell) {
    case 'zsh':
      return `#compdef traceback

_traceback() {
    local -a commands
    commands=(
        'tests:Browse, search, and run tests'
        'runs:Inspect past test runs and execution history'
        'workspaces:List and switch active Traceback workspace'
        'mobile:Mobile app verification on devices/emulators'
        'doctor:Run diagnostics on your Traceback setup'
        'setup:Install Appium and drivers'
        'skills:Install and manage Traceback agent skills'
        'mcp:Start Traceback MCP server'
        'config:Manage configuration'
        'project:Manage projects'
        'login:Authenticate with Traceback via browser'
        'update:Check for updates'
        'completion:Generate shell completion script'
    )

    _arguments -C \\
        '1: :->command' \\
        '*:: :->args'

    case $state in
        command)
            _describe -t commands 'traceback command' commands
            ;;
        args)
            case $words[1] in
                mobile)
                    _values 'mobile commands' 'verify' 'dev' 'test'
                    ;;
                runs)
                    _values 'runs commands' 'get'
                    ;;
                config)
                    _values 'config commands' 'get' 'set' 'list' 'reset'
                    ;;
                project)
                    _values 'project commands' 'list' 'get' 'init'
                    ;;
                skills)
                    _values 'skills commands' 'list' 'init' 'check'
                    ;;
                *)
                    ;;
            esac
            ;;
    esac
}

compdef _traceback traceback
`;

    case 'bash':
      return `_traceback_completion() {
    local cur prev words cword
    _init_completion || return

    local commands="tests runs workspaces mobile doctor setup skills mcp config project login update completion"
    local global_flags="--help -h --version -v --json --debug -d --silent --no-color --ci"

    if [[ \${cword} -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "\${commands} \${global_flags}" -- "\${cur}") )
        return 0
    fi

    case "\${words[1]}" in
        mobile)
            COMPREPLY=( $(compgen -W "verify dev test --goal -g --platform -p --device --apk --app" -- "\${cur}") )
            ;;
        runs)
            COMPREPLY=( $(compgen -W "get --json" -- "\${cur}") )
            ;;
        config)
            COMPREPLY=( $(compgen -W "get set list reset" -- "\${cur}") )
            ;;
        project)
            COMPREPLY=( $(compgen -W "list get init" -- "\${cur}") )
            ;;
        skills)
            COMPREPLY=( $(compgen -W "list init check" -- "\${cur}") )
            ;;
        *)
            COMPREPLY=( $(compgen -W "\${global_flags}" -- "\${cur}") )
            ;;
    esac
}

complete -F _traceback_completion traceback
`;

    case 'fish':
      return `# Fish completion for traceback
complete -c traceback -f

# Main commands
complete -c traceback -n "__fish_use_subcommand" -a "tests" -d "Browse, search, and run tests"
complete -c traceback -n "__fish_use_subcommand" -a "runs" -d "Inspect past test runs"
complete -c traceback -n "__fish_use_subcommand" -a "workspaces" -d "List and switch active workspace"
complete -c traceback -n "__fish_use_subcommand" -a "mobile" -d "Mobile app verification"
complete -c traceback -n "__fish_use_subcommand" -a "doctor" -d "Run diagnostics"
complete -c traceback -n "__fish_use_subcommand" -a "setup" -d "Install Appium and drivers"
complete -c traceback -n "__fish_use_subcommand" -a "skills" -d "Manage agent skills"
complete -c traceback -n "__fish_use_subcommand" -a "mcp" -d "Start MCP server"
complete -c traceback -n "__fish_use_subcommand" -a "config" -d "Manage configuration"
complete -c traceback -n "__fish_use_subcommand" -a "project" -d "Manage projects"
complete -c traceback -n "__fish_use_subcommand" -a "login" -d "Authenticate with Traceback"
complete -c traceback -n "__fish_use_subcommand" -a "update" -d "Check for updates"
complete -c traceback -n "__fish_use_subcommand" -a "completion" -d "Generate shell completion"

# Flags
complete -c traceback -s h -l help -d "Display help"
complete -c traceback -s v -l version -d "Display version"
complete -c traceback -s d -l debug -d "Enable debug logging"
complete -c traceback -l json -d "JSON output"
complete -c traceback -l silent -d "Silent mode"
complete -c traceback -l no-color -d "Disable color"
complete -c traceback -l ci -d "CI mode"
`;

    default:
      return '';
  }
}
