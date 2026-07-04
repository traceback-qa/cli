export interface FileStore {
  readJson: <T>(filePath: string) => T | null;
  writeJson: (filePath: string, data: unknown) => void;
  readText: (filePath: string) => string | null;
  writeText: (filePath: string, content: string) => void;
  exists: (filePath: string) => boolean;
  delete: (filePath: string) => void;
}

export interface EncryptedStore {
  set: (key: string, value: string) => Promise<void>;
  get: (key: string) => Promise<string | null>;
  delete: (key: string) => Promise<void>;
}
