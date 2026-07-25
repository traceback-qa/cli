export interface StoredToken {
  accessToken: string;
  workspaceId: string;
  workspaceSlug: string;
  tokenId?: string;
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

export interface AuthService {
  loginWithBrowser: () => Promise<StoredToken>;
  logout: () => Promise<void>;
  getToken: () => Promise<StoredToken | null>;
  isAuthenticated: () => Promise<boolean>;
  getCurrentAccount: () => Promise<{ email: string; accountId: string } | null>;
}
