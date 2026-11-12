import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuthService } from '../../src/infrastructure/auth/auth.refresher.js';
import type { AuthStore, StoredToken } from '../../src/infrastructure/auth/auth.types.js';
import type { ApiClient } from '../../src/infrastructure/api/api.types.js';

vi.mock('../../src/platform/open-url.js', () => ({ openUrl: vi.fn(async () => true) }));

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function makeStore(initial: StoredToken | null = null): AuthStore & { value: StoredToken | null } {
  const store = {
    value: initial,
    get: async () => store.value,
    set: async (t: StoredToken) => {
      store.value = t;
    },
    delete: async () => {
      store.value = null;
    },
  };
  return store;
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

const token: StoredToken = {
  accessToken: 'tb_live_x',
  apiKeyId: 'key-1',
  workspaceId: 'ws-1',
  workspaceSlug: 'acme',
  issuedAt: 1,
};

function makeApi(overrides: Partial<ApiClient>): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    setBaseUrl: vi.fn(),
    setAuthToken: vi.fn(),
    setLogger: vi.fn(),
    getAxiosInstance: vi.fn(),
    ...overrides,
  } as ApiClient;
}

describe('auth service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('verifySession distinguishes none / valid / invalid / unverified', async () => {
    const store = makeStore(null);
    const get = vi.fn();
    const svc = createAuthService(makeApi({ get }), store, logger);

    expect(await svc.verifySession()).toEqual({ state: 'none' });

    store.value = token;
    get.mockResolvedValueOnce({ data: { email: 'a@b.c', user_id: 'u1', full_name: 'A' } });
    expect((await svc.verifySession()).state).toBe('valid');

    get.mockRejectedValueOnce(httpError(401));
    expect((await svc.verifySession()).state).toBe('invalid');

    get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await svc.verifySession()).state).toBe('unverified');
  });

  it('logout revokes the key server-side and clears the store, even if revoke fails', async () => {
    const store = makeStore(token);
    const del = vi.fn().mockRejectedValue(httpError(500));
    const svc = createAuthService(makeApi({ delete: del }), store, logger);

    await svc.logout();

    expect(del).toHaveBeenCalledWith('/api/v1/auth/api-keys/key-1');
    expect(store.value).toBeNull();
  });

  it('login stores the token (with api_key_id) once approved', async () => {
    const store = makeStore();
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          device_code: 'd',
          user_code: 'ABCD-EFGH',
          verification_url: 'https://app.test/cli-login?code=ABCD-EFGH',
          expires_in: 900,
          interval: 2,
        },
      })
      .mockRejectedValueOnce(httpError(202))
      .mockResolvedValueOnce({
        data: {
          status: 'completed',
          api_key: 'tb_live_new',
          api_key_id: 'key-9',
          workspace_id: 'ws',
          workspace_slug: 'slug',
        },
      });
    const onCode = vi.fn();
    const svc = createAuthService(makeApi({ post }), store, logger);

    const p = svc.loginWithBrowser({ onCode });
    await vi.runAllTimersAsync();
    const result = await p;

    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCD-EFGH' }));
    expect(result.apiKeyId).toBe('key-9');
    expect(store.value?.accessToken).toBe('tb_live_new');
  });

  it('login fails fast after repeated non-pending errors instead of polling for 5 minutes', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        data: { device_code: 'd', user_code: 'X', verification_url: 'https://app.test/x?a=1' },
      })
      .mockRejectedValue(httpError(500));
    const svc = createAuthService(makeApi({ post }), makeStore(), logger);

    const p = svc.loginWithBrowser();
    const assertion = expect(p).rejects.toThrow(/Could not reach Traceback/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(post).toHaveBeenCalledTimes(1 + 5);
  });
});
