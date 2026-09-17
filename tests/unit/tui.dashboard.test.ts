import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TuiDashboard } from '../../src/infrastructure/ui/dashboard/tui.dashboard.js';

describe('TuiDashboard', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('initializes and renders correctly', () => {
    const dashboard = new TuiDashboard({
      runId: 'test-run-12345',
      testName: 'Login and Checkout Test',
      environment: 'staging',
      targetName: 'Brave Browser',
    });

    dashboard.start();
    expect(writeSpy).toHaveBeenCalled();

    dashboard.startStep(1, 'Navigate to login page', 'Locating URL input');
    dashboard.completeStep(1, 'success', 'Loaded successfully');
    dashboard.addIssue({
      severity: 'warn',
      title: 'Slow network response',
      source: 'cdp',
      timestamp: Date.now(),
    });
    dashboard.setReport('1 step completed with 0 errors');
    dashboard.setFinalStatus('PASSED');

    dashboard.stop();
    // Restores terminal buffer
    expect(writeSpy).toHaveBeenCalledWith('\x1B[?1049l\x1B[?25h');
  });
});
