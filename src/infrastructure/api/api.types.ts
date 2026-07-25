import type { AxiosInstance } from 'axios';
import type { Logger } from '../logger/logger.types.js';

export interface ApiResponse<T> {
  data: T;
  meta?: {
    page?: number;
    total?: number;
    limit?: number;
  };
}

export interface ApiClient {
  get: <T>(url: string, config?: Record<string, unknown>) => Promise<ApiResponse<T>>;
  post: <T>(
    url: string,
    data?: unknown,
    config?: Record<string, unknown>,
  ) => Promise<ApiResponse<T>>;
  put: <T>(
    url: string,
    data?: unknown,
    config?: Record<string, unknown>,
  ) => Promise<ApiResponse<T>>;
  patch: <T>(
    url: string,
    data?: unknown,
    config?: Record<string, unknown>,
  ) => Promise<ApiResponse<T>>;
  delete: <T>(url: string, config?: Record<string, unknown>) => Promise<ApiResponse<T>>;
  setBaseUrl: (url: string) => void;
  setAuthToken: (token: string | null) => void;
  setLogger: (logger: Logger) => void;
  getAxiosInstance: () => AxiosInstance;
}

export interface ApiClientOptions {
  baseUrl: string;
  timeout?: number;
  retryAttempts?: number;
  authToken?: string;
  logger?: Logger;
}
