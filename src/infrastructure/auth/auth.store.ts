import type { StoredToken, AuthStore } from './auth.types.js';
import { encrypt, decrypt } from '../../platform/keychain.js';
import type { FileStore } from '../storage/storage.types.js';

export function createFileAuthStore(filePath: string, fileStore: FileStore): AuthStore {
  return {
    async get(): Promise<StoredToken | null> {
      const raw = fileStore.readText(filePath);
      if (!raw) return null;

      const decrypted = decrypt(raw);
      if (!decrypted) return null;

      try {
        return JSON.parse(decrypted) as StoredToken;
      } catch {
        return null;
      }
    },

    async set(token: StoredToken): Promise<void> {
      const serialized = JSON.stringify(token);
      const encrypted = encrypt(serialized);
      fileStore.writeText(filePath, encrypted);
    },

    async delete(): Promise<void> {
      fileStore.delete(filePath);
    },
  };
}
