import { execSync } from 'node:child_process';

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
