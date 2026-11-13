import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUIService } from '../../src/infrastructure/ui/formatting.js';

describe('UIService formatting', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('formats info, success, warn, error correctly', () => {
    const ui = createUIService({
      json: false,
      debug: false,
      silent: false,
      noColor: true,
      interactive: true,
    });

    ui.info('Test info message');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ℹ'), 'Test info message');

    ui.success('Test success message');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('✔'), 'Test success message');

    ui.warn('Test warn message');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('⚠'), 'Test warn message');

    ui.error('Test error message');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('✖'), 'Test error message');
  });

  it('renders JSON in json mode', () => {
    const ui = createUIService({
      json: true,
      debug: false,
      silent: false,
      noColor: true,
      interactive: false,
    });

    ui.table(['Name', 'Age'], [['Alice', '30']]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([{ Name: 'Alice', Age: '30' }]));

    ui.error('Fatal failure');
    expect(errorSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Fatal failure' }));
  });

  it('renders tables properly using cli-table3', () => {
    const ui = createUIService({
      json: false,
      debug: false,
      silent: false,
      noColor: true,
      interactive: true,
    });

    ui.table(['Header1', 'Header2'], [['Val1', 'Val2']]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0]?.[0];
    expect(output).toContain('Header1');
    expect(output).toContain('Val1');
  });

  it('provides step, badge, banner and errorCard helpers', () => {
    const ui = createUIService({
      json: false,
      debug: false,
      silent: false,
      noColor: true,
      interactive: true,
    });

    ui.step(1, 'Running check', 'Checking connectivity');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[1]'));

    const badge = ui.badge('ACTIVE', 'success');
    expect(badge).toContain('ACTIVE');

    ui.banner('Traceback CLI', 'v1.0.0');
    expect(logSpy).toHaveBeenCalled();

    ui.errorCard('Command Failed', 'Something went wrong', ['Try running traceback login'], {
      quickFix: 'traceback login',
      docsUrl: 'https://docs.traceback.dev',
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('supports OSC 8 hyperlinks and progress bar', () => {
    const ui = createUIService({
      json: false,
      debug: false,
      silent: false,
      noColor: true,
      interactive: true,
    });

    const link = ui.link('Docs', 'https://docs.traceback.dev');
    expect(link).toContain('Docs (https://docs.traceback.dev)');

    const bar = ui.progressBar(5, 10, 10);
    expect(bar).toContain('50%');
  });

  it('renders tree output correctly', () => {
    const ui = createUIService({
      json: false,
      debug: false,
      silent: false,
      noColor: true,
      interactive: true,
    });

    ui.treeStart('Running Test', 'SauceDemo Checkout');
    ui.treeStep(1, 'Open URL', 'success', 150);
    ui.treeAgent('Clicking cart button');
    ui.treeStep(2, 'Submit Order', 'running');
    ui.treeEnd('Test Passed', true);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Running Test'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Open URL'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('AI Agent:'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Test Passed'));
  });

  it('renders emptyState helper', () => {
    const ui = createUIService({
      json: false,
      debug: false,
      silent: false,
      noColor: true,
      interactive: true,
    });

    ui.emptyState('No tests found', 'Get started by running a test', [
      { label: 'Run test', command: 'traceback tests' },
    ]);

    expect(logSpy).toHaveBeenCalled();
  });

  it('supports copyToClipboard and bell', () => {
    const ui = createUIService({
      json: false,
      debug: false,
      silent: false,
      noColor: true,
      interactive: true,
    });

    const copied = ui.copyToClipboard('https://app.traceback.dev');
    expect(copied).toBe(true);

    expect(() => ui.bell()).not.toThrow();
  });
});
