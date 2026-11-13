/* eslint-disable no-console -- this module IS the CLI's terminal output layer */
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import Table from 'cli-table3';
import boxen from 'boxen';
import type { UIService, SpinnerHandle, UIOptions } from './ui.types.js';

export const UI_THEME = {
  brand: chalk.hex('#6366F1'),
  brandBold: chalk.hex('#6366F1').bold,
  success: chalk.green,
  successBold: chalk.green.bold,
  warning: chalk.yellow,
  warningBold: chalk.yellow.bold,
  error: chalk.red,
  errorBold: chalk.red.bold,
  dim: chalk.gray,
  bold: chalk.bold,
  cyan: chalk.cyan,
  magenta: chalk.magenta,
};

export function createUIService(opts: UIOptions): UIService {
  let activeSpinner: SpinnerHandle | null = null;

  if (opts.noColor) {
    chalk.level = 0;
  }

  function maybeLog(...args: unknown[]): void {
    if (opts.silent) return;
    console.log(...args);
  }

  const ui: UIService = {
    spinner(text: string): SpinnerHandle {
      if (opts.json || opts.silent || !opts.interactive) {
        return createNoopSpinner();
      }

      if (activeSpinner) {
        activeSpinner.stop();
      }

      const s = createOraSpinner(text, opts.noColor);
      activeSpinner = s;
      return s;
    },

    info(message: string): void {
      if (opts.json) return;
      maybeLog(UI_THEME.brand('ℹ'), message);
    },

    success(message: string): void {
      if (opts.json) return;
      maybeLog(UI_THEME.success('✔'), message);
    },

    warn(message: string): void {
      if (opts.json) return;
      maybeLog(UI_THEME.warning('⚠'), message);
    },

    error(message: string): void {
      if (opts.silent) return;
      if (opts.json) {
        console.error(JSON.stringify({ error: message }));
        return;
      }
      console.error(UI_THEME.errorBold('✖'), message);
    },

    hint(message: string): void {
      if (opts.json || opts.silent) return;
      maybeLog(chalk.dim('  ' + message));
    },

    debug(message: string): void {
      if (!opts.debug || opts.silent) return;
      maybeLog(chalk.gray('[debug]'), message);
    },

    step(stepNum: number | string, title: string, detail?: string): void {
      if (opts.json || opts.silent) return;
      const prefix = chalk.cyan(`[${stepNum}]`);
      maybeLog(`${prefix} ${chalk.bold(title)}`);
      if (detail) {
        maybeLog(chalk.dim(`    ${detail}`));
      }
    },

    badge(
      label: string,
      type:
        | 'info'
        | 'success'
        | 'warn'
        | 'error'
        | 'brand'
        | 'dim'
        | 'passed'
        | 'failed'
        | 'running'
        | 'queued' = 'info',
    ): string {
      switch (type) {
        case 'success':
        case 'passed':
          return chalk.bgGreen.black.bold(` ${label} `);
        case 'error':
        case 'failed':
          return chalk.bgRed.white.bold(` ${label} `);
        case 'warn':
          return chalk.bgYellow.black.bold(` ${label} `);
        case 'running':
          return chalk.bgCyan.black.bold(` ${label} `);
        case 'queued':
          return chalk.bgMagenta.white.bold(` ${label} `);
        case 'brand':
          return chalk.bgHex('#6366F1').white.bold(` ${label} `);
        case 'dim':
          return chalk.bgGray.white(` ${label} `);
        default:
          return chalk.bgCyan.black.bold(` ${label} `);
      }
    },

    banner(title: string, subtitle?: string): void {
      if (opts.json || opts.silent) return;
      const content = `${UI_THEME.brandBold(title)}${subtitle ? `\n${chalk.dim(subtitle)}` : ''}`;
      maybeLog(
        boxen(content, {
          padding: 1,
          margin: { top: 0, bottom: 1, left: 0, right: 0 },
          borderColor: '#6366F1',
          borderStyle: 'round',
        }),
      );
    },

    errorCard(
      title: string,
      message: string,
      suggestions: string[] = [],
      extraOpts?: { quickFix?: string; docsUrl?: string },
    ): void {
      if (opts.silent) return;
      if (opts.json) {
        console.error(
          JSON.stringify({
            error: title,
            details: message,
            suggestions,
            quickFix: extraOpts?.quickFix,
            docsUrl: extraOpts?.docsUrl,
          }),
        );
        return;
      }

      let content = `${UI_THEME.errorBold(title)}\n\n${chalk.white(message)}`;

      if (extraOpts?.quickFix) {
        content += `\n\n${chalk.bold('Quick Fix:')}\n  ${chalk.cyan('$')} ${chalk.bold(extraOpts.quickFix)}`;
      }

      if (suggestions.length > 0) {
        content +=
          `\n\n${chalk.bold('Suggestions:')}\n` +
          suggestions.map((s) => `  ${chalk.cyan('•')} ${s}`).join('\n');
      }

      if (extraOpts?.docsUrl) {
        content += `\n\n${chalk.dim('Documentation:')} ${ui.link(extraOpts.docsUrl, extraOpts.docsUrl)}`;
      }

      console.error(
        boxen(content, {
          padding: 1,
          margin: { top: 0, bottom: 1, left: 0, right: 0 },
          borderColor: 'red',
          borderStyle: 'round',
        }),
      );
    },

    emptyState(
      title: string,
      description: string,
      actions: Array<{ label: string; command: string }> = [],
    ): void {
      if (opts.json || opts.silent) return;
      let content = `${chalk.bold(title)}\n\n${chalk.dim(description)}`;
      if (actions.length > 0) {
        content +=
          `\n\n${chalk.bold('Quick actions:')}\n` +
          actions
            .map((a) => `  ${chalk.cyan('•')} ${a.label}: ${chalk.hex('#6366F1').bold(a.command)}`)
            .join('\n');
      }
      maybeLog(
        boxen(content, {
          padding: 1,
          margin: { top: 0, bottom: 1, left: 0, right: 0 },
          borderColor: 'gray',
          borderStyle: 'round',
        }),
      );
    },

    link(text: string, url: string): string {
      if (opts.noColor) {
        return text === url ? text : `${text} (${url})`;
      }
      return `\u001B]8;;${url}\u001B\\${chalk.cyan.underline(text)}\u001B]8;;\u001B\\`;
    },

    progressBar(current: number, total: number, width: number = 20): string {
      const percentage = Math.min(100, Math.max(0, Math.round((current / (total || 1)) * 100)));
      const filledLength = Math.round((width * percentage) / 100);
      const emptyLength = Math.max(0, width - filledLength);
      const bar =
        chalk.hex('#6366F1')('█'.repeat(filledLength)) + chalk.gray('░'.repeat(emptyLength));
      return `[${bar}] ${percentage}%`;
    },

    treeStart(title: string, subtitle?: string): void {
      if (opts.json || opts.silent) return;
      maybeLog(`${chalk.hex('#6366F1')('┌')}  ${chalk.bold(title)}`);
      if (subtitle) {
        maybeLog(`${chalk.hex('#6366F1')('│')}  ${chalk.dim(subtitle)}`);
      }
      maybeLog(chalk.hex('#6366F1')('│'));
    },

    treeStep(
      stepNum: number | string,
      title: string,
      status: 'running' | 'success' | 'fail' | 'info' = 'info',
      durationMs?: number,
      detail?: string,
    ): void {
      if (opts.json || opts.silent) return;

      let icon = chalk.cyan('◇');
      let statusText = '';

      if (status === 'success') {
        icon = chalk.green('✔');
      } else if (status === 'fail') {
        icon = chalk.red('✖');
      } else if (status === 'running') {
        icon = chalk.yellow('▲');
        statusText = chalk.yellow(' [running]');
      }

      const duration = durationMs !== undefined ? chalk.dim(` (${durationMs}ms)`) : '';
      const prefix = chalk.dim(`[${stepNum}]`);
      maybeLog(`${icon}  ${prefix} ${title}${duration}${statusText}`);

      if (detail) {
        maybeLog(`${chalk.hex('#6366F1')('│')}  ${chalk.dim(detail)}`);
      }
    },

    treeAgent(message: string): void {
      if (opts.json || opts.silent) return;
      maybeLog(
        `${chalk.hex('#6366F1')('│')}  ${chalk.dim('↳')} ${chalk.magenta.bold('AI Agent:')} ${chalk.italic(`"${message}"`)}`,
      );
    },

    treeEnd(summary: string, success: boolean = true): void {
      if (opts.json || opts.silent) return;
      maybeLog(chalk.hex('#6366F1')('│'));
      const statusIcon = success ? chalk.green.bold('✔') : chalk.red.bold('✖');
      const text = success ? chalk.green.bold(summary) : chalk.red.bold(summary);
      maybeLog(`${chalk.hex('#6366F1')('└')}  ${statusIcon} ${text}`);
    },

    table(
      headers: string[],
      rows: string[][],
      tableOpts?: { colWidths?: number[]; compact?: boolean },
    ): void {
      if (opts.json) {
        const result = rows.map((row) => {
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => {
            obj[h] = row[i] ?? '';
          });
          return obj;
        });
        console.log(JSON.stringify(result));
        return;
      }

      const tableConfig: Record<string, unknown> = {
        head: headers.map((h) => UI_THEME.brandBold(h)),
        chars: tableOpts?.compact
          ? {
              top: '',
              'top-mid': '',
              'top-left': '',
              'top-right': '',
              bottom: '',
              'bottom-mid': '',
              'bottom-left': '',
              'bottom-right': '',
              left: '',
              'left-mid': '',
              mid: '',
              'mid-mid': '',
              right: '',
              'right-mid': '',
              middle: ' ',
            }
          : {
              top: '─',
              'top-mid': '┬',
              'top-left': '┌',
              'top-right': '┐',
              bottom: '─',
              'bottom-mid': '┴',
              'bottom-left': '└',
              'bottom-right': '┘',
              left: '│',
              'left-mid': '├',
              mid: '─',
              'mid-mid': '┼',
              right: '│',
              'right-mid': '┤',
              middle: '│',
            },
        style: {
          head: ['cyan'],
          border: ['gray'],
          compact: Boolean(tableOpts?.compact),
        },
      };

      if (tableOpts?.colWidths) {
        tableConfig.colWidths = tableOpts.colWidths;
      }

      const table = new Table(tableConfig);

      for (const row of rows) {
        table.push(row);
      }

      maybeLog(table.toString());
    },

    box(content: string, optsBox?: { title?: string; borderColor?: string }): void {
      if (opts.json) return;
      const output = boxen(content, {
        padding: 1,
        margin: { top: 0, bottom: 1, left: 0, right: 0 },
        borderColor: optsBox?.borderColor || 'cyan',
        borderStyle: 'round',
        title: optsBox?.title,
        titleAlignment: 'left',
      });
      maybeLog(output);
    },

    renderJson(data: unknown): void {
      console.log(JSON.stringify(data, null, 2));
    },

    isJsonMode(): boolean {
      return opts.json;
    },

    isDebugEnabled(): boolean {
      return opts.debug;
    },

    isSilent(): boolean {
      return opts.silent;
    },

    clearSpinner(): void {
      if (activeSpinner) {
        activeSpinner.stop();
        activeSpinner = null;
      }
    },

    bell(): void {
      if (opts.silent || opts.json || !opts.interactive) return;
      process.stdout.write('\u0007');
    },

    copyToClipboard(text: string): boolean {
      if (opts.silent || opts.json || !opts.interactive) return false;
      try {
        const base64 = Buffer.from(text).toString('base64');
        process.stdout.write(`\x1b]52;c;${base64}\x07`);
        return true;
      } catch {
        return false;
      }
    },
  };

  return ui;
}

function createOraSpinner(text: string, noColor: boolean): SpinnerHandle {
  let currentText = text;
  const spinner: Ora = ora({
    text,
    color: noColor ? undefined : 'cyan',
    discardStdin: false,
  });

  spinner.start();

  return {
    start(newText?: string): void {
      if (newText) currentText = newText;
      spinner.start(currentText);
    },

    succeed(newText?: string): void {
      spinner.succeed(newText ?? currentText);
    },

    fail(newText?: string): void {
      spinner.fail(newText ?? currentText);
    },

    warn(newText?: string): void {
      spinner.warn(newText ?? currentText);
    },

    info(newText?: string): void {
      spinner.info(newText ?? currentText);
    },

    stop(): void {
      spinner.stop();
    },

    setText(newText: string): void {
      currentText = newText;
      spinner.text = newText;
    },
  };
}

function createNoopSpinner(): SpinnerHandle {
  return {
    start: () => {},
    succeed: () => {},
    fail: () => {},
    warn: () => {},
    info: () => {},
    stop: () => {},
    setText: () => {},
  };
}
