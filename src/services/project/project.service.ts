import type { ProjectService, ProjectServiceDeps } from './project.types.js';
import {
  createProjectEndpoints,
  type CreateProjectInput,
  type DeployInput,
} from '../../infrastructure/api/endpoints/project.endpoints.js';

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const endpoints = createProjectEndpoints(deps.api);

  return {
    async list() {
      deps.logger.debug('Listing projects');
      return endpoints.list() as Promise<unknown[]>;
    },

    async get(id: string) {
      deps.logger.debug(`Getting project: ${id}`);
      return endpoints.get(id);
    },

    async create(input) {
      deps.logger.debug('Creating project');
      return endpoints.create(input as unknown as CreateProjectInput);
    },

    async deploy(projectId, input) {
      deps.logger.debug(`Deploying project: ${projectId}`);
      return endpoints.deploy(projectId, input as unknown as DeployInput);
    },

    async delete(id) {
      deps.logger.debug(`Deleting project: ${id}`);
      return endpoints.delete(id);
    },
  };
}
