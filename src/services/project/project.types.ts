import type { Logger } from '../../infrastructure/logger/logger.types.js';
import type { ApiClient } from '../../infrastructure/api/api.types.js';

export interface ProjectService {
  list: () => Promise<unknown[]>;
  get: (id: string) => Promise<unknown>;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  deploy: (projectId: string, input: Record<string, unknown>) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
}

export interface ProjectServiceDeps {
  api: ApiClient;
  logger: Logger;
}
