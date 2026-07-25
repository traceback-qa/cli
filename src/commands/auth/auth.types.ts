export interface AuthCommandsDeps {
  getCfToken: () => Promise<string | null>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getStatus: () => Promise<{ email: string; accountId: string } | null>;
}
