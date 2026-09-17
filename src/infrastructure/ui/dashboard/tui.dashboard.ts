/**
 * Split-Pane Live TUI Dashboard for Traceback Test Runs.
 *
 * Provides a split-screen terminal interface:
 * - Header: Session details, status badge, elapsed timer
 * - Left Pane: Step timeline with status icons and elapsed time
 * - Right Pane: Live agent reasoning, decision stream, and issue alerts
 * - Footer: Live shortcuts and metrics
 */

import chalk from 'chalk';

export interface StepItem {
  stepNumber: number;
  title: string;
  status: 'running' | 'passed' | 'failed';
  startTime: number;
  endTime?: number;
  detail?: string;
  error?: string;
}

export interface IssueItem {
  severity: string;
  title: string;
  source: string;
  timestamp: number;
}

export interface DashboardOptions {
  runId: string;
  testName: string;
  environment: string;
  targetName: string;
  onDetach?: () => void;
  onOpenWeb?: () => void;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function padEndAnsi(str: string, width: number): string {
  const visibleLen = stripAnsi(str).length;
  if (visibleLen >= width) {
    const stripped = stripAnsi(str);
    if (stripped.length > width) {
      return stripped.slice(0, width - 1) + '…';
    }
    return str;
  }
  return str + ' '.repeat(Math.max(0, width - visibleLen));
}

export class TuiDashboard {
  private runId: string;
  private testName: string;
  private environment: string;
  private targetName: string;
  private status: string = 'RUNNING';
  private startTime: number = Date.now();
  private endTime: number | null = null;
  private steps: StepItem[] = [];
  private currentReasoning: string = 'Waiting for agent to initialize...';
  private issues: IssueItem[] = [];
  private reportSummary: string | null = null;
  private timerInterval: NodeJS.Timeout | null = null;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex = 0;
  private isActive = false;
  private onDetach?: () => void;
  private onOpenWeb?: () => void;

  constructor(opts: DashboardOptions) {
    this.runId = opts.runId;
    this.testName = opts.testName;
    this.environment = opts.environment;
    this.targetName = opts.targetName;
    this.onDetach = opts.onDetach;
    this.onOpenWeb = opts.onOpenWeb;
  }

  public start(): void {
    if (this.isActive) return;
    this.isActive = true;

    // Switch to alternate screen buffer and hide cursor
    process.stdout.write('\x1B[?1049h\x1B[?25l');

    // Bind keypress handling
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', this.handleInput);
      } catch {
        // Fallback gracefully
      }
    }

    // Bind window resize listener
    process.stdout.on('resize', this.render);

    // Start render loop (10 FPS for smooth spinners and elapsed timers)
    this.timerInterval = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      this.render();
    }, 100);

    this.render();
  }

  public stop(): void {
    if (!this.isActive) return;
    this.isActive = false;

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    process.stdout.removeListener('resize', this.render);

    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.removeListener('data', this.handleInput);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {
        // Ignore
      }
    }

    // Restore main terminal buffer and show cursor
    process.stdout.write('\x1B[?1049l\x1B[?25h');
  }

  private handleInput = (data: Buffer): void => {
    const key = data.toString();
    if (key === 'q' || key === '\u0003') {
      // Quit / Detach
      this.stop();
      this.onDetach?.();
    } else if (key.toLowerCase() === 'o') {
      this.onOpenWeb?.();
    }
  };

  public setStatus(status: string): void {
    this.status = status.toUpperCase();
    this.render();
  }

  public startStep(stepNumber: number, title: string, reasoning?: string | null): void {
    const existing = this.steps.find((s) => s.stepNumber === stepNumber);
    if (existing) {
      existing.title = title;
      existing.status = 'running';
    } else {
      this.steps.push({
        stepNumber,
        title,
        status: 'running',
        startTime: Date.now(),
      });
    }
    if (reasoning) {
      this.currentReasoning = reasoning;
    }
    this.render();
  }

  public completeStep(
    stepNumber: number,
    outcome: string,
    detail?: string | null,
    error?: string | null,
  ): void {
    let step = this.steps.find((s) => s.stepNumber === stepNumber);
    if (!step) {
      step = {
        stepNumber,
        title: detail || `Step ${stepNumber}`,
        status: outcome === 'failure' || error ? 'failed' : 'passed',
        startTime: Date.now() - 1000,
        endTime: Date.now(),
      };
      this.steps.push(step);
    } else {
      step.status = outcome === 'failure' || error ? 'failed' : 'passed';
      step.endTime = Date.now();
      if (detail) step.detail = detail;
      if (error) step.error = error;
    }
    this.render();
  }

  public addIssue(issue: IssueItem): void {
    this.issues.push(issue);
    this.render();
  }

  public setReport(summary: string): void {
    this.reportSummary = summary;
    this.render();
  }

  public setFinalStatus(finalStatus: string): void {
    this.status = finalStatus.toUpperCase();
    this.endTime = Date.now();
    this.render();
  }

  private getFormattedElapsed(): string {
    const end = this.endTime ?? Date.now();
    const totalSecs = Math.floor((end - this.startTime) / 1000);
    const mins = Math.floor(totalSecs / 60)
      .toString()
      .padStart(2, '0');
    const secs = (totalSecs % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  public render = (): void => {
    if (!this.isActive) return;

    const termWidth = Math.max(70, process.stdout.columns || 80);
    const termHeight = Math.max(20, process.stdout.rows || 24);

    const leftColWidth = Math.floor((termWidth - 5) * 0.48);
    const rightColWidth = termWidth - leftColWidth - 5;
    const bodyHeight = termHeight - 8;

    const lines: string[] = [];

    // ── Header Box ──────────────────────────────────────
    const statusBadge =
      this.status === 'PASSED'
        ? chalk.bgGreen.black.bold(' PASSED ')
        : this.status === 'FAILED'
          ? chalk.bgRed.white.bold(' FAILED ')
          : chalk.bgHex('#6366F1').white.bold(' RUNNING ');

    const timerBadge = chalk.yellow(`⏱  ${this.getFormattedElapsed()}`);
    const topBarTitle = ` ${chalk.hex('#6366F1').bold('TRACEBACK')} ${chalk.bold('LIVE TEST RUNNER')} `;
    const topBarRight = ` ${timerBadge}  ${statusBadge} `;
    const topBarDashes = Math.max(
      0,
      termWidth - 2 - stripAnsi(topBarTitle).length - stripAnsi(topBarRight).length,
    );

    lines.push(
      chalk.hex('#6366F1')('┌─') +
        topBarTitle +
        chalk.hex('#6366F1')('─'.repeat(topBarDashes)) +
        topBarRight +
        chalk.hex('#6366F1')('─┐'),
    );

    const testInfoLine = `  ${chalk.bold(this.testName)}  ${chalk.dim('•')}  Env: ${chalk.cyan(this.environment)}  ${chalk.dim('•')}  Target: ${chalk.white(this.targetName)}  ${chalk.dim('•')}  Run: ${chalk.gray(this.runId.slice(0, 12))}...`;
    lines.push(
      chalk.hex('#6366F1')('│') +
        padEndAnsi(testInfoLine, termWidth - 2) +
        chalk.hex('#6366F1')('│'),
    );

    // ── Split Pane Top Divider ──────────────────────────
    lines.push(
      chalk.hex('#6366F1')('├') +
        chalk.hex('#6366F1')('─'.repeat(leftColWidth + 2)) +
        chalk.hex('#6366F1')('┬') +
        chalk.hex('#6366F1')('─'.repeat(rightColWidth + 2)) +
        chalk.hex('#6366F1')('┤'),
    );

    // ── Column Headers ──────────────────────────────────
    const leftHeader = ` ${chalk.bold.cyan('📋 Step Timeline')} ${chalk.dim(`(${this.steps.filter((s) => s.status === 'passed').length}/${this.steps.length})`)}`;
    const rightHeader = ` ${chalk.bold.hex('#6366F1')('🤖 Agent Reasoning & Telemetry')}`;
    lines.push(
      chalk.hex('#6366F1')('│') +
        padEndAnsi(leftHeader, leftColWidth + 2) +
        chalk.hex('#6366F1')('│') +
        padEndAnsi(rightHeader, rightColWidth + 2) +
        chalk.hex('#6366F1')('│'),
    );

    // ── Body Rows ───────────────────────────────────────
    const leftLines: string[] = [];
    if (this.steps.length === 0) {
      leftLines.push(chalk.dim('  Initializing test execution...'));
    } else {
      for (const step of this.steps) {
        let icon: string;
        let timeStr = '';
        if (step.status === 'passed') {
          icon = chalk.green('✔');
          const dur = step.endTime ? ((step.endTime - step.startTime) / 1000).toFixed(1) : '0.0';
          timeStr = chalk.dim(` [${dur}s]`);
        } else if (step.status === 'failed') {
          icon = chalk.red('✖');
          const dur = step.endTime ? ((step.endTime - step.startTime) / 1000).toFixed(1) : '0.0';
          timeStr = chalk.red(` [${dur}s]`);
        } else {
          icon = chalk.cyan(this.spinnerFrames[this.spinnerIndex] ?? '⠋');
          const dur = ((Date.now() - step.startTime) / 1000).toFixed(1);
          timeStr = chalk.cyan(` [${dur}s]`);
        }

        const title =
          step.title.length > leftColWidth - 14
            ? step.title.slice(0, leftColWidth - 15) + '…'
            : step.title;
        leftLines.push(` ${icon} ${chalk.bold(`Step ${step.stepNumber}:`)} ${title}${timeStr}`);
        if (step.error) {
          leftLines.push(`    ${chalk.red(`↳ ${step.error.slice(0, leftColWidth - 8)}`)}`);
        }
      }
    }

    const rightLines: string[] = [];
    rightLines.push(` ${chalk.bold.white('Active Reasoning:')}`);
    const words = this.currentReasoning.split(' ');
    let currentLine = '  ';
    for (const word of words) {
      if ((currentLine + word).length > rightColWidth - 2) {
        rightLines.push(chalk.gray(currentLine));
        currentLine = '  ' + word + ' ';
      } else {
        currentLine += word + ' ';
      }
    }
    if (currentLine.trim()) {
      rightLines.push(chalk.gray(currentLine));
    }

    // Issues section
    if (this.issues.length > 0) {
      rightLines.push('');
      rightLines.push(` ${chalk.bold.yellow('⚠ Issues Detected:')}`);
      for (const issue of this.issues.slice(-3)) {
        rightLines.push(
          `  ${chalk.bgYellow.black(` ${issue.severity.toUpperCase()} `)} ${chalk.white(issue.title.slice(0, rightColWidth - 14))}`,
        );
      }
    }

    if (this.reportSummary) {
      rightLines.push('');
      rightLines.push(` ${chalk.bold.green('📊 Report Summary:')}`);
      rightLines.push(`  ${chalk.white(this.reportSummary.slice(0, rightColWidth - 4))}`);
    }

    for (let i = 0; i < bodyHeight; i++) {
      const l = leftLines[i] || '';
      const r = rightLines[i] || '';
      lines.push(
        chalk.hex('#6366F1')('│') +
          padEndAnsi(l, leftColWidth + 2) +
          chalk.hex('#6366F1')('│') +
          padEndAnsi(r, rightColWidth + 2) +
          chalk.hex('#6366F1')('│'),
      );
    }

    // ── Bottom Divider & Footer ─────────────────────────
    lines.push(
      chalk.hex('#6366F1')('├') +
        chalk.hex('#6366F1')('─'.repeat(leftColWidth + 2)) +
        chalk.hex('#6366F1')('┴') +
        chalk.hex('#6366F1')('─'.repeat(rightColWidth + 2)) +
        chalk.hex('#6366F1')('┤'),
    );

    const footerText = `  ${chalk.dim('Shortcuts:')} ${chalk.white.bold('[q]')} ${chalk.dim('Detach')}  ${chalk.dim('•')}  ${chalk.white.bold('[o]')} ${chalk.dim('Open Web')}  ${chalk.dim('•')}  ${chalk.white.bold('[Ctrl+C]')} ${chalk.dim('Stop')}`;
    lines.push(
      chalk.hex('#6366F1')('│') + padEndAnsi(footerText, termWidth - 2) + chalk.hex('#6366F1')('│'),
    );

    lines.push(
      chalk.hex('#6366F1')('└') +
        chalk.hex('#6366F1')('─'.repeat(termWidth - 2)) +
        chalk.hex('#6366F1')('┘'),
    );

    // Reset cursor to top-left and render whole buffer in a single atomic write
    process.stdout.write('\x1B[H' + lines.join('\n'));
  };
}
