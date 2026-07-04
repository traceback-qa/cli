import type { Logger } from '../../infrastructure/logger/logger.types.js';
import type { ApiClient } from '../../infrastructure/api/api.types.js';

export interface RunService {
  execute: (command: string, args?: string[]) => Promise<unknown>;
  list: () => Promise<unknown[]>;
}

export interface RunServiceDeps {
  api: ApiClient;
  logger: Logger;
}
