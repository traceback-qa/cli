import type { ApiClient } from '../api.types.js';

export function createAuthEndpoints(client: ApiClient) {
  return {
    login: (input: { email: string; password: string }) =>
      client.post<LoginResponse>('/auth/login', input).then((r) => r.data),

    loginDevice: (input: { deviceCode: string }) =>
      client.post<LoginResponse>('/auth/device', input).then((r) => r.data),

    refreshToken: (refreshToken: string) =>
      client.post<RefreshResponse>('/auth/refresh', { refreshToken }).then((r) => r.data),

    logout: (refreshToken: string) =>
      client.post<void>('/auth/logout', { refreshToken }).then((r) => r.data),

    status: () => client.get<AuthStatusResponse>('/auth/status').then((r) => r.data),
  };
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
  accountId: string;
  email: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
}

export interface AuthStatusResponse {
  authenticated: boolean;
  email?: string;
  accountId?: string;
  expiresAt?: number;
}
