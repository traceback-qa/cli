export interface UIService {
  spinner: (text: string) => SpinnerHandle;
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  hint: (message: string) => void;
  debug: (message: string) => void;
  step: (stepNum: number | string, title: string, detail?: string) => void;
  badge: (
    label: string,
    type?:
      | 'info'
      | 'success'
      | 'warn'
      | 'error'
      | 'brand'
      | 'dim'
      | 'passed'
      | 'failed'
      | 'running'
      | 'queued',
  ) => string;
  banner: (title: string, subtitle?: string) => void;
  errorCard: (
    title: string,
    message: string,
    suggestions?: string[],
    opts?: { quickFix?: string; docsUrl?: string },
  ) => void;
  emptyState: (
    title: string,
    description: string,
    actions?: Array<{ label: string; command: string }>,
  ) => void;
  table: (
    headers: string[],
    rows: string[][],
    options?: { colWidths?: number[]; compact?: boolean },
  ) => void;
  box: (content: string, opts?: { title?: string; borderColor?: string }) => void;
  link: (text: string, url: string) => string;
  progressBar: (current: number, total: number, width?: number) => string;
  treeStart: (title: string, subtitle?: string) => void;
  treeStep: (
    stepNum: number | string,
    title: string,
    status?: 'running' | 'success' | 'fail' | 'info',
    durationMs?: number,
    detail?: string,
  ) => void;
  treeAgent: (message: string) => void;
  treeEnd: (summary: string, success?: boolean) => void;
  renderJson: (data: unknown) => void;
  isJsonMode: () => boolean;
  isDebugEnabled: () => boolean;
  isSilent: () => boolean;
  clearSpinner: () => void;
  bell: () => void;
  copyToClipboard: (text: string) => boolean;
}

export interface SpinnerHandle {
  start: (text?: string) => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
  warn: (text?: string) => void;
  info: (text?: string) => void;
  stop: () => void;
  setText: (text: string) => void;
}

export interface UIOptions {
  json: boolean;
  debug: boolean;
  silent: boolean;
  noColor: boolean;
  interactive: boolean;
}
