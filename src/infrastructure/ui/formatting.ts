/* eslint-disable no-console -- this module IS the CLI's terminal output layer */
import chalk from 'chalk';
import boxen from 'boxen';
import type { UIService, SpinnerHandle, UIOptions } from './ui.types.js';

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

      const s = createSpinner(text);
      activeSpinner = s;
      return s;
    },

    info(message: string): void {
      if (opts.json) return;
      maybeLog(chalk.blue('ℹ'), message);
    },

    success(message: string): void {
      if (opts.json) return;
      maybeLog(chalk.green('✔'), message);
    },

    warn(message: string): void {
      if (opts.json) return;
      maybeLog(chalk.yellow('⚠'), message);
    },

    error(message: string): void {
      if (opts.silent) return;
      if (opts.json) {
        console.error(JSON.stringify({ error: message }));
        return;
      }
      console.error(chalk.red('✖'), message);
    },

    hint(message: string): void {
      if (opts.json || opts.silent) return;
      maybeLog(chalk.dim('  ' + message));
    },

    debug(message: string): void {
      if (!opts.debug || opts.silent) return;
      maybeLog(chalk.gray('[debug]'), message);
    },

    table(headers: string[], rows: string[][]): void {
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
      maybeLog(formatTable(headers, rows));
    },

    box(content: string, optsBox?: { title?: string }): void {
      if (opts.json) return;
      const output = boxen(content, {
        padding: 1,
        margin: 1,
        borderColor: 'cyan',
        borderStyle: 'round',
        title: optsBox?.title,
      });
      maybeLog(output);
    },

    renderJson(data: unknown): void {
      // Compact single-line JSON: machine consumers (the MCP server, `mobile verify`
      // parsing) read stdout line-by-line as JSONL — one object per line. Pretty-
      // printing across multiple lines would break `json.loads(line)` on every
      // partial line.
      console.log(JSON.stringify(data));
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

function createSpinner(text: string): SpinnerHandle {
  let currentText = text;
  let active = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;

  return {
    start(newText?: string): void {
      if (active) return;
      if (newText) currentText = newText;
      active = true;
      interval = setInterval(() => {
        process.stderr.write(`\r${chalk.cyan(frames[frameIndex])} ${currentText}`);
        frameIndex = (frameIndex + 1) % frames.length;
      }, 80);
    },

    succeed(newText?: string): void {
      stop();
      console.error(`\r${chalk.green('✔')} ${newText ?? currentText}`);
    },

    fail(newText?: string): void {
      stop();
      console.error(`\r${chalk.red('✖')} ${newText ?? currentText}`);
    },

    warn(newText?: string): void {
      stop();
      console.error(`\r${chalk.yellow('⚠')} ${newText ?? currentText}`);
    },

    stop(): void {
      if (interval) clearInterval(interval);
      if (active) {
        process.stderr.write('\r\u001b[K');
      }
      active = false;
      interval = null;
    },

    setText(newText: string): void {
      currentText = newText;
    },
  };

  function stop(): void {
    if (interval) clearInterval(interval);
    interval = null;
    active = false;
  }
}

function createNoopSpinner(): SpinnerHandle {
  return {
    start: () => {},
    succeed: () => {},
    fail: () => {},
    warn: () => {},
    stop: () => {},
    setText: () => {},
  };
}

function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const headerLen = h.length;
    const maxDataLen = rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0);
    return Math.max(headerLen, maxDataLen) + 2;
  });

  const separator = '+' + colWidths.map((w) => '-'.repeat(w)).join('+') + '+';
  const headerRow =
    '|' + headers.map((h, i) => chalk.bold(padCenter(h, colWidths[i]!))).join('|') + '|';
  const dataRows = rows.map(
    (row) => '|' + row.map((cell, i) => padCenter(cell, colWidths[i]!)).join('|') + '|',
  );

  return [separator, headerRow, separator, ...dataRows, separator].join('\n');
}

function padCenter(str: string, width: number): string {
  const pad = width - str.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

