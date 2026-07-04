import type { StoredToken, AuthService, AuthStore } from './auth.types.js';
import type { ApiClient } from '../api/api.types.js';
import type { Logger } from '../logger/logger.types.js';
import { NotAuthenticatedError } from '../../errors/auth.error.js';
import { hostname } from 'os';

interface LoginSessionResponse {
  session_id: string;
  login_url: string;
}

interface LoginWaitResponse {
  status: string;
  token?: string;
  user_id?: string;
  token_id?: string;
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 300_000; // 5 minutes

export function createAuthService(
  apiClient: ApiClient,
  authStore: AuthStore,
  logger: Logger,
): AuthService {
  return {
    async loginWithBrowser(): Promise<StoredToken> {
      // Step 1: Create a login session on the backend
      logger.debug('Creating login session...');
      const session = await apiClient.post<LoginSessionResponse>('/cli/login', {
        hostname: hostname(),
      });

      const { session_id, login_url } = session.data;
      logger.debug(`Login URL: ${login_url}`);

      // Step 2: Open the browser for the user to approve
      const { exec } = await import('child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} "${login_url}"`);

      // Step 3: Poll until the user approves or timeout
      const startTime = Date.now();
      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);

        try {
          const result = await apiClient.get<LoginWaitResponse>(
            `/cli/login/wait?session_id=${session_id}`,
          );

          // Check if the response contains a completed session
          const data = result.data as any;
          if (data?.status === 'complete' && data?.token) {
            const token: StoredToken = {
              accessToken: data.token,
              tokenId: data.token_id || '',
              userId: data.user_id || '',
              email: '',
              issuedAt: Date.now(),
            };

            await authStore.set(token);
            apiClient.setAuthToken(token.accessToken);

            logger.debug('Login successful');
            return token;
          }

          // status === 'pending' — keep polling
        } catch (error: any) {
          const status = error?.response?.status;
          // 202 = still pending, keep polling
          if (status === 202) continue;
          // 404/410 = session expired
          if (status === 404 || status === 410) {
            throw new Error('Login session expired. Please try again.');
          }
          // Other network errors — keep polling (might be transient)
          logger.debug(`Poll error: ${error?.message}`);
        }
      }

      throw new Error('Login timed out. Please try again.');
    },

    async logout(): Promise<void> {
      const token = await authStore.get();
      if (token?.tokenId) {
        try {
          await apiClient.post(`/cli/tokens/${token.tokenId}/revoke`);
        } catch {
          logger.debug('Failed to revoke token server-side, clearing locally');
        }
      }
      apiClient.setAuthToken(null);
      await authStore.delete();
      logger.debug('Logged out');
    },

    async getToken(): Promise<StoredToken | null> {
      return authStore.get();
    },

    async isAuthenticated(): Promise<boolean> {
      const token = await authStore.get();
      return token !== null;
    },

    async getCurrentAccount(): Promise<{ email: string; accountId: string } | null> {
      const token = await authStore.get();
      if (!token) return null;
      return { email: token.email || token.userId, accountId: token.userId };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
