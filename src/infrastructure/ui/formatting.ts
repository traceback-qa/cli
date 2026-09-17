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
      type: 'info' | 'success' | 'warn' | 'error' | 'brand' | 'dim' = 'info',
    ): string {
      switch (type) {
        case 'success':
          return chalk.bgGreen.black.bold(` ${label} `);
        case 'error':
          return chalk.bgRed.white.bold(` ${label} `);
        case 'warn':
          return chalk.bgYellow.black.bold(` ${label} `);
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

    errorCard(title: string, message: string, suggestions: string[] = []): void {
      if (opts.silent) return;
      if (opts.json) {
        console.error(JSON.stringify({ error: title, details: message, suggestions }));
        return;
      }

      let content = `${UI_THEME.errorBold(title)}\n\n${chalk.white(message)}`;
      if (suggestions.length > 0) {
        content +=
          `\n\n${chalk.bold('Troubleshooting / Suggestions:')}\n` +
          suggestions.map((s) => `  ${chalk.cyan('•')} ${s}`).join('\n');
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
