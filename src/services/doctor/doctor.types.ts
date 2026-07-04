import type { Logger } from '../../infrastructure/logger/logger.types.js';
import type { ConfigService } from '../../infrastructure/config/config.types.js';
import type { FileStore } from '../../infrastructure/storage/storage.types.js';
import type { AuthService } from '../../infrastructure/auth/auth.types.js';
import type { ApiClient } from '../../infrastructure/api/api.types.js';
import type { UpdateChecker } from '../../infrastructure/update/update.types.js';

export type DoctorCheckStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheckResult {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  suggestion?: string;
}

export interface DoctorService {
  runDiagnostics: () => Promise<DoctorCheckResult[]>;
}

export interface DoctorServiceDeps {
  config: ConfigService;
  auth: AuthService;
  api: ApiClient;
  updateChecker: UpdateChecker;
  fileStore: FileStore;
  logger: Logger;
  configDir: string;
  logsDir: string;
}
