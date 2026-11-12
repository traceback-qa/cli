import type { StoredToken, AuthStore } from './auth.types.js';
import {
  encrypt,
  decrypt,
  keychainGet,
  keychainSet,
  keychainDelete,
} from '../../platform/keychain.js';
import type { FileStore } from '../storage/storage.types.js';

const KEYCHAIN_ACCOUNT = 'default';

function parse(raw: string | null): StoredToken | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

/**
 * Stores the token in the OS credential store when one is available
 * (macOS Keychain, Linux libsecret). Otherwise — or for tokens written by
 * older versions — falls back to an encrypted 0600 file, and migrates file
 * tokens into the keychain on first read.
 */
export function createFileAuthStore(filePath: string, fileStore: FileStore): AuthStore {
  function readFile(): StoredToken | null {
    const raw = fileStore.readText(filePath);
    if (!raw) return null;
    return parse(decrypt(raw));
  }

  return {
    async get(): Promise<StoredToken | null> {
      const kc = keychainGet(KEYCHAIN_ACCOUNT);
      if (kc.available) {
        const fromKeychain = parse(kc.value);
        if (fromKeychain) return fromKeychain;
      }

      const fromFile = readFile();
      if (fromFile && kc.available && keychainSet(KEYCHAIN_ACCOUNT, JSON.stringify(fromFile))) {
        fileStore.delete(filePath); // migrated
      }
      return fromFile;
    },

    async set(token: StoredToken): Promise<void> {
      const serialized = JSON.stringify(token);
      if (keychainSet(KEYCHAIN_ACCOUNT, serialized)) {
        fileStore.delete(filePath);
        return;
      }
      fileStore.writeText(filePath, encrypt(serialized));
    },

    async delete(): Promise<void> {
      keychainDelete(KEYCHAIN_ACCOUNT);
      fileStore.delete(filePath);
    },
  };
}
