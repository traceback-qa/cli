import type { TelemetryService, TelemetryEvent, TelemetryOptions } from './telemetry.types.js';
import type { Logger } from '../logger/logger.types.js';

export function createTelemetryService(opts: TelemetryOptions, logger: Logger): TelemetryService {
  let enabled = opts.enabled;
  const buffer: TelemetryEvent[] = [];
  const MAX_BUFFER = 50;

  const service: TelemetryService = {
    track(event: TelemetryEvent): void {
      if (!enabled) return;

      const fullEvent: TelemetryEvent = {
        ...event,
        timestamp: event.timestamp ?? Date.now(),
      };

      buffer.push(fullEvent);
      logger.trace(`Telemetry: ${event.name}`);

      if (buffer.length >= MAX_BUFFER) {
        void service.flush();
      }
    },

    isEnabled(): boolean {
      return enabled;
    },

    setEnabled(value: boolean): void {
      enabled = value;
      if (!enabled) {
        buffer.length = 0;
      }
    },

    async flush(): Promise<void> {
      if (buffer.length === 0) return;

      try {
        logger.debug(`Flushing ${buffer.length} telemetry events`);
        buffer.length = 0;
      } catch {
        logger.debug('Failed to flush telemetry events');
      }
    },
  };

  return service;
}

export function createNoopTelemetryService(): TelemetryService {
  return {
    track: () => {},
    isEnabled: () => false,
    setEnabled: () => {},
    flush: async () => {},
  };
}
