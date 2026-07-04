export interface UIService {
  spinner: (text: string) => SpinnerHandle;
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  hint: (message: string) => void;
  debug: (message: string) => void;
  table: (headers: string[], rows: string[][]) => void;
  box: (content: string, opts?: { title?: string }) => void;
  renderJson: (data: unknown) => void;
  isJsonMode: () => boolean;
  isDebugEnabled: () => boolean;
  isSilent: () => boolean;
  clearSpinner: () => void;
}

export interface SpinnerHandle {
  start: (text?: string) => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
  warn: (text?: string) => void;
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
