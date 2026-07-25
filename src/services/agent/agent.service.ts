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
      return await (endpoints.list() as Promise<unknown[]>);
    },

    async get(id: string) {
      deps.logger.debug(`Getting agent: ${id}`);
      return await endpoints.get(id);
    },

    async create(input) {
      deps.logger.debug('Creating agent');
      return await endpoints.create(input as unknown as CreateAgentInput);
    },

    async delete(id) {
      deps.logger.debug(`Deleting agent: ${id}`);
      return await endpoints.delete(id);
    },
  };
}
