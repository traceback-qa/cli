import { execFileSync, execSync } from 'node:child_process';

function getMachineId(): string {
  try {
    switch (process.platform) {
      case 'darwin': {
        const id = execSync(
          "ioreg -rd1 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/ {print $4}'",
          {
            encoding: 'utf-8',
          },
        ).trim();
        return id;
      }
      case 'linux': {
        const id = execSync('cat /etc/machine-id', { encoding: 'utf-8' }).trim();
        return id || execSync('cat /var/lib/dbus/machine-id', { encoding: 'utf-8' }).trim();
      }
      case 'win32': {
        return process.env.COMPUTERNAME ?? 'windows-machine';
      }
      default:
        return os.hostname();
    }
  } catch {
    return os.hostname();
  }
}

import os from 'node:os';

export function getPlatformKey(): string {
  const machineId = getMachineId();
  return `${process.platform}:${machineId}`;
}

const CRYPTO_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT = 'traceback-cli-salt-v1';

import crypto from 'node:crypto';

function deriveKey(): Buffer {
  const machineKey = getPlatformKey();
  return crypto.pbkdf2Sync(machineKey, SALT, 100_000, KEY_LENGTH, 'sha512');
}

function getCipherKey(): Buffer {
  return deriveKey();
}

export function encrypt(value: string): string {
  const key = getCipherKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(CRYPTO_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const result = Buffer.concat([iv, authTag, encrypted]);
  return result.toString('base64');
}

export function decrypt(encryptedValue: string): string | null {
  try {
    const key = getCipherKey();
    const buffer = Buffer.from(encryptedValue, 'base64');

    const iv = buffer.subarray(0, IV_LENGTH);
    const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(CRYPTO_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

// ── OS credential store ────────────────────────────────────────────────
// macOS: Keychain via `security`. Linux: libsecret via `secret-tool`.
// Other platforms (or when the tool is missing) report "unavailable" and
// callers fall back to the encrypted file.

const KEYCHAIN_SERVICE = 'traceback-cli';

export type KeychainResult<T> = { available: false } | { available: true; value: T };

function run(cmd: string, args: string[], input?: string): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      input,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

export function keychainSupported(): boolean {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'linux') return run('which', ['secret-tool']) !== null;
  return false;
}

export function keychainSet(account: string, secret: string): boolean {
  if (process.platform === 'darwin') {
    // The secret is briefly visible in this process's argv; it is hex/base64 only.
    return (
      run('security', [
        'add-generic-password',
        '-U',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        account,
        '-w',
        secret,
      ]) !== null
    );
  }
  if (process.platform === 'linux' && keychainSupported()) {
    return (
      run(
        'secret-tool',
        ['store', '--label=Traceback CLI', 'service', KEYCHAIN_SERVICE, 'account', account],
        secret,
      ) !== null
    );
  }
  return false;
}

export function keychainGet(account: string): KeychainResult<string | null> {
  if (process.platform === 'darwin') {
    const out = run('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
    ]);
    return { available: true, value: out ? out.trim() : null };
  }
  if (process.platform === 'linux' && keychainSupported()) {
    const out = run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
    return { available: true, value: out ? out.trim() : null };
  }
  return { available: false };
}

export function keychainDelete(account: string): void {
  if (process.platform === 'darwin') {
    run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
  } else if (process.platform === 'linux' && keychainSupported()) {
    run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
  }
}
