export interface UpdateResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  type: 'major' | 'minor' | 'patch' | null;
}

export interface UpdateChecker {
  check: () => Promise<UpdateResult | null>;
  shouldCheck: () => boolean;
}
