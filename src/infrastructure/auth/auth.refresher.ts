import type { StoredToken, AuthService, AuthStore, SessionStatus } from './auth.types.js';
import type { ApiClient } from '../api/api.types.js';
import type { Logger } from '../logger/logger.types.js';
import type { ConfigService } from '../config/config.types.js';
import { openUrl } from '../../platform/open-url.js';

interface CliLoginResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval?: number;
}

interface CliTokenResponse {
  status: string;
  api_key: string;
  api_key_id?: string;
  workspace_id: string;
  workspace_slug: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

export function createAuthService(
  apiClient: ApiClient,
  authStore: AuthStore,
  logger: Logger,
  configService?: ConfigService,
): AuthService {
  return {
    async loginWithBrowser(opts = {}): Promise<StoredToken> {
      logger.debug('Starting CLI device authorization...');
      const session = await apiClient.post<CliLoginResponse>('/api/v1/auth/cli/login');

      const { device_code, user_code, verification_url } = session.data;
      const pollIntervalMs = session.data.interval
        ? Math.max(session.data.interval * 1000, DEFAULT_POLL_INTERVAL_MS)
        : DEFAULT_POLL_INTERVAL_MS;

      let finalUrl = verification_url;
      if (configService) {
        try {
          const config = await configService.loadGlobalConfig();
          if (config.workspaceId) {
            const u = new URL(verification_url);
            u.searchParams.set('workspace', config.workspaceId);
            finalUrl = u.toString();
          }
        } catch {
          // ignore config load / URL errors
        }
      }

      logger.debug(`User code: ${user_code}`);
      logger.debug(`Verification URL: ${finalUrl}`);

      const browserOpened = await openUrl(finalUrl);
      opts.onCode?.({ userCode: user_code, url: finalUrl, browserOpened });

      const pollDeadline = Date.now() + POLL_TIMEOUT_MS;
      let consecutiveErrors = 0;

      while (Date.now() < pollDeadline) {
        await sleep(pollIntervalMs);

        try {
          const result = await apiClient.post<CliTokenResponse>('/api/v1/auth/cli/token', {
            device_code,
          });
          consecutiveErrors = 0;

          const data = result.data;
          if (data?.status === 'completed' && data?.api_key) {
            const token: StoredToken = {
              accessToken: data.api_key,
              apiKeyId: data.api_key_id,
              workspaceId: data.workspace_id,
              workspaceSlug: data.workspace_slug,
              issuedAt: Date.now(),
            };

            await authStore.set(token);
            apiClient.setAuthToken(token.accessToken);
            logger.debug('Login successful');
            return token;
          }
        } catch (error: unknown) {
          const status = statusOf(error);
          // 202 = still pending, keep polling
          if (status === 202) {
            consecutiveErrors = 0;
            continue;
          }
          if (status === 403 || status === 409) {
            throw new Error(
              'Login was rejected or the session was already consumed. Run `traceback login` to try again.',
            );
          }
          if (status === 410) {
            throw new Error('Login session expired. Run `traceback login` to try again.');
          }
          if (status === 404) {
            throw new Error('Login session invalid. Please try again.');
          }
          if (status === 429) {
            // Rate limited: back off but keep the session alive.
            await sleep(pollIntervalMs * 2);
            continue;
          }
          // Anything else (5xx, network, unexpected 4xx): tolerate a few blips, then fail loudly.
          consecutiveErrors++;
          const message = error instanceof Error ? error.message : String(error);
          logger.debug(
            `Poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}): ${message}`,
          );
          if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
            throw new Error(
              `Could not reach Traceback while waiting for approval (${message}). Check your connection and run \`traceback login\` again.`,
            );
          }
        }
      }

      throw new Error('Login timed out after 5 minutes. Please try again.');
    },

    async logout(): Promise<void> {
      const token = await authStore.get();

      // Best-effort server-side revoke so a leaked/stale key stops working.
      if (token?.apiKeyId) {
        try {
          apiClient.setAuthToken(token.accessToken);
          await apiClient.delete(`/api/v1/auth/api-keys/${encodeURIComponent(token.apiKeyId)}`);
          logger.debug('Revoked API key on server');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.debug(`Could not revoke API key server-side: ${message}`);
        }
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

    async verifySession(): Promise<SessionStatus> {
      const token = await authStore.get();
      if (!token) return { state: 'none' };

      try {
        const result = await apiClient.get<{
          email: string;
          user_id: string;
          full_name: string;
        }>('/api/v1/auth/me');
        return {
          state: 'valid',
          account: { email: result.data.email, accountId: result.data.user_id },
        };
      } catch (error) {
        const status = statusOf(error);
        if (status === 401 || status === 403) return { state: 'invalid' };
        return {
          state: 'unverified',
          account: {
            email: token.email ?? token.workspaceSlug,
            accountId: token.workspaceId,
          },
        };
      }
    },

    async getCurrentAccount(): Promise<{
      email: string;
      accountId: string;
    } | null> {
      const status = await this.verifySession();
      return status.state === 'valid' || status.state === 'unverified' ? status.account : null;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
