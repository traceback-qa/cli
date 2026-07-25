import axios, { type AxiosInstance, type AxiosError } from 'axios';
import type { ApiClient, ApiClientOptions, ApiResponse } from './api.types.js';
import type { Logger } from '../logger/logger.types.js';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRY_ATTEMPTS = 3;

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const instance = axios.create({
    baseURL: opts.baseUrl,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `traceback-cli/${getVersion()}`,
    },
  });

  let authToken: string | null = opts.authToken ?? null;
  let logger: Logger | undefined = opts.logger;

  function getToken(): string | null {
    return authToken;
  }

  function setToken(token: string | null): void {
    authToken = token;
  }

  function getLogger(): Logger | undefined {
    return logger;
  }

  instance.interceptors.request.use((config) => {
    const token = getToken();
    if (token && config.headers) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    getLogger()?.debug(`API request: ${String(config.method).toUpperCase()} ${config.url}`);
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      getLogger()?.debug(`API response: ${response.status} ${response.config.url}`);
      return response;
    },
    async (error: AxiosError) => {
      getLogger()?.debug(`API error: ${String(error.response?.status)} ${error.config?.url}`);
      return await Promise.reject(error);
    },
  );

  async function request<T>(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    url: string,
    data?: unknown,
    config?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const maxRetries = opts.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await instance.request<T>({
          method,
          url,
          data,
          ...config,
        });
        return {
          data: response.data,
        };
      } catch (error) {
        if (attempt === maxRetries) {
          throw error;
        }
        if (!isRetryable(error)) {
          throw error;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        logger?.debug(`Retry attempt ${attempt + 1} after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Unreachable');
  }

  return {
    get: <T>(url: string, config?: Record<string, unknown>) =>
      request<T>('get', url, undefined, config),

    post: <T>(url: string, data?: unknown, config?: Record<string, unknown>) =>
      request<T>('post', url, data, config),

    put: <T>(url: string, data?: unknown, config?: Record<string, unknown>) =>
      request<T>('put', url, data, config),

    patch: <T>(url: string, data?: unknown, config?: Record<string, unknown>) =>
      request<T>('patch', url, data, config),

    delete: <T>(url: string, config?: Record<string, unknown>) =>
      request<T>('delete', url, undefined, config),

    setBaseUrl(url: string): void {
      instance.defaults.baseURL = url;
    },

    setAuthToken(token: string | null): void {
      setToken(token);
    },

    setLogger(l: Logger): void {
      logger = l;
    },

    getAxiosInstance(): AxiosInstance {
      return instance;
    },
  };
}

function isRetryable(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    if (error.response && RETRYABLE_STATUSES.has(error.response.status)) {
      return true;
    }
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true;
    }
  }
  return false;
}

function getVersion(): string {
  return process.env.TRACEBACK_VERSION ?? '0.0.0';
}
