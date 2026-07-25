import { describe, it, expect } from 'vitest';
import { createFileStore } from '../../src/infrastructure/storage/file.store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../../src/infrastructure/logger/logger.factory.js';

describe('FileStore', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceback-test-'));

  it('should write and read JSON', () => {
    const store = createFileStore();
    const filePath = path.join(tmpDir, 'test.json');

    store.writeJson(filePath, { foo: 'bar' });
    const result = store.readJson<{ foo: string }>(filePath);

    expect(result).toEqual({ foo: 'bar' });
  });

  it('should return null for non-existent file', () => {
    const store = createFileStore();
    const result = store.readJson(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('should delete files', () => {
    const store = createFileStore();
    const filePath = path.join(tmpDir, 'delete-me.json');
    store.writeJson(filePath, { test: true });
    store.delete(filePath);
    expect(store.exists(filePath)).toBe(false);
  });
});

describe('Logger', () => {
  it('should create a logger', () => {
    const logger = createLogger({ level: 'silent' });
    expect(logger).toBeDefined();
    expect(logger.getLevel()).toBe('silent');
  });

  it('should change log level', () => {
    const logger = createLogger({ level: 'info' });
    logger.setLevel('debug');
    expect(logger.getLevel()).toBe('debug');
  });
});

describe('Config', () => {
  it('should load config from file', async () => {
    const { loadGlobalConfigFromFile } =
      await import('../../src/infrastructure/config/config.loader.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceback-test-'));
    const filePath = path.join(tmpDir, 'config.json');

    fs.writeFileSync(
      filePath,
      JSON.stringify({ apiUrl: 'https://custom.api.dev', defaultEnvironment: 'staging' }),
    );

    const config = loadGlobalConfigFromFile(filePath);
    expect(config).not.toBeNull();
    expect(config?.apiUrl).toBe('https://custom.api.dev');
    expect(config?.defaultEnvironment).toBe('staging');

    fs.unlinkSync(filePath);
    fs.rmdirSync(tmpDir);
  });

  it('should return null for invalid config file', async () => {
    const { loadGlobalConfigFromFile } =
      await import('../../src/infrastructure/config/config.loader.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceback-test-'));
    const filePath = path.join(tmpDir, 'config.json');

    fs.writeFileSync(filePath, 'not valid json');

    const config = loadGlobalConfigFromFile(filePath);
    expect(config).toBeNull();

    fs.unlinkSync(filePath);
    fs.rmdirSync(tmpDir);
  });
});
