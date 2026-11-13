export interface StoredToken {
  accessToken: string;
  workspaceId: string;
  workspaceSlug: string;
  tokenId?: string;
  apiKeyId?: string;
  userId?: string;
  email?: string;
  issuedAt: number;
  expiresAt?: number;
}

export interface AuthStore {
  get: () => Promise<StoredToken | null>;
  set: (token: StoredToken) => Promise<void>;
  delete: () => Promise<void>;
}

export interface LoginOptions {
  /** Called with the device code and URL once the session starts. */
  onCode?: (info: { userCode: string; url: string; browserOpened: boolean }) => void;
}

export type SessionStatus =
  | { state: 'none' }
  | { state: 'valid'; account: { email: string; accountId: string } }
  | { state: 'invalid' }
  | { state: 'unverified'; account: { email: string; accountId: string } };

export interface AuthService {
  loginWithBrowser: (opts?: LoginOptions) => Promise<StoredToken>;
  /** Checks the stored key against the API. `unverified` = API unreachable. */
  verifySession: () => Promise<SessionStatus>;
  logout: () => Promise<void>;
  getToken: () => Promise<StoredToken | null>;
  isAuthenticated: () => Promise<boolean>;
  getCurrentAccount: () => Promise<{ email: string; accountId: string } | null>;
}
