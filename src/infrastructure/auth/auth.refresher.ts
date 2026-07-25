import type { StoredToken, AuthService, AuthStore } from './auth.types.js';
import type { ApiClient } from '../api/api.types.js';
import type { Logger } from '../logger/logger.types.js';

interface CliLoginResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
}

interface CliTokenResponse {
  status: string;
  api_key: string;
  workspace_id: string;
  workspace_slug: string;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 300_000; // 5 minutes

export function createAuthService(
  apiClient: ApiClient,
  authStore: AuthStore,
  logger: Logger,
): AuthService {
  return {
    async loginWithBrowser(): Promise<StoredToken> {
      // Step 1: Initiate device authorization
      logger.debug('Starting CLI device authorization...');
      const session = await apiClient.post<CliLoginResponse>('/api/v1/auth/cli/login');

      const { device_code, user_code, verification_url } = session.data;
      logger.debug(`User code: ${user_code}`);
      logger.debug(`Verification URL: ${verification_url}`);

      // Step 2: Print the user code and open the browser
      // eslint-disable-next-line no-console -- direct user-facing terminal output for the login flow
      console.log(`\n  Copy this code: ${user_code}\n  Or open: ${verification_url}\n`);

      const { exec } = await import('child_process');
      const platform = process.platform;
      const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} "${verification_url}"`);

      // Step 3: Poll until the user approves or timeout
      const pollDeadline = Date.now() + POLL_TIMEOUT_MS;

      while (Date.now() < pollDeadline) {
        await sleep(POLL_INTERVAL_MS);

        try {
          const result = await apiClient.post<CliTokenResponse>('/api/v1/auth/cli/token', {
            device_code,
          });

          const data = result.data;
          if (data?.status === 'completed' && data?.api_key) {
            const token: StoredToken = {
              accessToken: data.api_key,
              workspaceId: data.workspace_id,
              workspaceSlug: data.workspace_slug,
              issuedAt: Date.now(),
            };

            await authStore.set(token);
            apiClient.setAuthToken(token.accessToken);
            logger.debug('Login successful');
            return token;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
        } catch (error: any) {
          const status = error?.response?.status;
          // 202 = still pending, keep polling
          if (status === 202) continue;
          // 403 = rejected, 409 = already consumed — stop immediately
          if (status === 403 || status === 409) {
            throw new Error(
              'Login was rejected or the session was already consumed. Run `traceback login` to try again.',
            );
          }
          // 410 = session expired, stop immediately
          if (status === 410) {
            throw new Error('Login session expired. Run `traceback login` to try again.');
          }
          // 404 = invalid device code (shouldn't happen normally)
          if (status === 404) {
            throw new Error('Login session invalid. Please try again.');
          }
          // Other errors — might be transient, keep polling
          logger.debug(`Poll error: ${error?.message}`);
        }
      }

      throw new Error('Login timed out after 5 minutes. Please try again.');
    },

    async logout(): Promise<void> {
      const token = await authStore.get();
      // API keys don't have a revoke-by-token-id endpoint —
      // the user can revoke keys from the dashboard.
      // We just clear the local store.
      if (token) {
        logger.debug('Clearing local auth token');
      }
      apiClient.setAuthToken(null);
      await authStore.delete();
      logger.debug('Logged out');
    },

    async getToken(): Promise<StoredToken | null> {
      return await authStore.get();
    },

    async isAuthenticated(): Promise<boolean> {
      const token = await authStore.get();
      return token !== null;
    },

    async getCurrentAccount(): Promise<{
      email: string;
      accountId: string;
    } | null> {
      const token = await authStore.get();
      if (!token) return null;

      // Try to fetch the user profile from the API
      try {
        const result = await apiClient.get<{
          email: string;
          user_id: string;
          full_name: string;
        }>('/api/v1/auth/me');
        return {
          email: result.data.email,
          accountId: result.data.user_id,
        };
      } catch {
        // Fall back to what we have stored locally
        return {
          email: token.email ?? token.workspaceSlug,
          accountId: token.workspaceId,
        };
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
