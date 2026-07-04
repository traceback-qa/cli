import fs from 'node:fs';
import path from 'node:path';
import type { FileStore } from './storage.types.js';

export function createFileStore(): FileStore {
  return {
    readJson<T>(filePath: string): T | null {
      try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    writeJson(filePath: string, data: unknown): void {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    },

    readText(filePath: string): string | null {
      try {
        if (!fs.existsSync(filePath)) return null;
        return fs.readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    },

    writeText(filePath: string, content: string): void {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, { mode: 0o600 });
    },

    exists(filePath: string): boolean {
      return fs.existsSync(filePath);
    },

    delete(filePath: string): void {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    },
  };
}
