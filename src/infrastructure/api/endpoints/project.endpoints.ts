import type { ApiClient } from '../api.types.js';

export function createProjectEndpoints(client: ApiClient) {
  return {
    list: () => client.get<Project[]>('/projects').then((r) => r.data),

    get: (id: string) => client.get<Project>(`/projects/${id}`).then((r) => r.data),

    create: (input: CreateProjectInput) =>
      client.post<Project>('/projects', input).then((r) => r.data),

    deploy: (projectId: string, input: DeployInput) =>
      client.post<Project>(`/projects/${projectId}/deploy`, input).then((r) => r.data),

    delete: (id: string) => client.delete<void>(`/projects/${id}`).then(() => undefined),
  };
}

export interface Project {
  id: string;
  name: string;
  environment: string;
  status: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  environment?: string;
  orgId?: string;
}

export interface DeployInput {
  environment?: string;
  tag?: string;
  force?: boolean;
}
