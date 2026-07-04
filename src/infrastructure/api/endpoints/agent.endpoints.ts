import type { ApiClient } from '../api.types.js';

export function createAgentEndpoints(client: ApiClient) {
  return {
    list: () => client.get<Agent[]>('/agents').then((r) => r.data),

    get: (id: string) => client.get<Agent>(`/agents/${id}`).then((r) => r.data),

    create: (input: CreateAgentInput) =>
      client.post<Agent>('/agents', input).then((r) => r.data),

    delete: (id: string) => client.delete<void>(`/agents/${id}`).then(() => undefined),
  };
}

export interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'online' | 'offline' | 'error';
  projectId: string;
  createdAt: string;
}

export interface CreateAgentInput {
  name: string;
  type: string;
  projectId: string;
}
