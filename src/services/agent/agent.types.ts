import type { Logger } from '../../infrastructure/logger/logger.types.js';
import type { ApiClient } from '../../infrastructure/api/api.types.js';

export interface AgentService {
  list: () => Promise<unknown[]>;
  get: (id: string) => Promise<unknown>;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
}

export interface AgentServiceDeps {
  api: ApiClient;
  logger: Logger;
}
