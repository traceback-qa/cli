import type { AgentService, AgentServiceDeps } from './agent.types.js';
import {
  createAgentEndpoints,
  type CreateAgentInput,
} from '../../infrastructure/api/endpoints/agent.endpoints.js';

export function createAgentService(deps: AgentServiceDeps): AgentService {
  const endpoints = createAgentEndpoints(deps.api);

  return {
    async list() {
      deps.logger.debug('Listing agents');
      return endpoints.list() as Promise<unknown[]>;
    },

    async get(id: string) {
      deps.logger.debug(`Getting agent: ${id}`);
      return endpoints.get(id);
    },

    async create(input) {
      deps.logger.debug('Creating agent');
      return endpoints.create(input as unknown as CreateAgentInput);
    },

    async delete(id) {
      deps.logger.debug(`Deleting agent: ${id}`);
      return endpoints.delete(id);
    },
  };
}
