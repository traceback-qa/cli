import type { CliContext } from '../types/context.js';
import { NotAuthenticatedError } from '../errors/auth.error.js';

export function createRequireAuthMiddleware(ctx: CliContext) {
  return async function requireAuth(): Promise<void> {
    const isAuth = await ctx.infra.auth.isAuthenticated();
    if (!isAuth) {
      throw new NotAuthenticatedError();
    }

    const token = await ctx.infra.auth.getToken();
    if (token) {
      ctx.infra.api.setAuthToken(token.accessToken);
      ctx.infra.logger.debug(`Authenticated as ${token.email}`);
    }
  };
}
