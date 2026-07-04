export interface TelemetryEvent {
  name: string;
  timestamp: number;
  properties?: Record<string, string | number | boolean>;
}

export interface TelemetryService {
  track: (event: TelemetryEvent) => void;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  flush: () => Promise<void>;
}

export interface TelemetryOptions {
  enabled: boolean;
  apiUrl: string;
  authToken?: string;
}
