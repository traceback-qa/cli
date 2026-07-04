import type { RunService, RunServiceDeps } from './run.types.js';

export function createRunService(deps: RunServiceDeps): RunService {
  return {
    async execute(command: string, args?: string[]) {
      deps.logger.debug(`Executing: ${command} ${args?.join(' ') ?? ''}`);
      return deps.api.post('/run/execute', { command, args }).then((r) => r.data);
    },

    async list() {
      deps.logger.debug('Listing runs');
      return deps.api.get('/run').then((r) => r.data) as Promise<unknown[]>;
    },
  };
}
