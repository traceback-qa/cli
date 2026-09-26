import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SpecService } from '../../src/services/spec/spec.service.js';

describe('SpecService', () => {
  let tmpDir: string;
  let service: SpecService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-service-test-'));
    service = new SpecService();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('detectFramework', () => {
    it('detects Next.js project and sets default port 3000', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'my-next-app', dependencies: { next: '^14.0.0' } }),
      );

      const detection = service.detectFramework(tmpDir);
      expect(detection.framework).toBe('Next.js');
      expect(detection.defaultBaseUrl).toBe('http://localhost:3000');
      expect(detection.suggestedName).toBe('my-next-app');
    });

    it('detects Vite project and sets default port 5173', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'my-vite-app', devDependencies: { vite: '^5.0.0' } }),
      );

      const detection = service.detectFramework(tmpDir);
      expect(detection.framework).toBe('Vite');
      expect(detection.defaultBaseUrl).toBe('http://localhost:5173');
    });

    it('detects Django project from manage.py', () => {
      fs.writeFileSync(path.join(tmpDir, 'manage.py'), '#!/usr/bin/env python');

      const detection = service.detectFramework(tmpDir);
      expect(detection.framework).toBe('Django');
      expect(detection.defaultBaseUrl).toBe('http://localhost:8000');
    });

    it('detects FastAPI project from requirements.txt', () => {
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'fastapi>=0.100.0\nuvicorn\n');

      const detection = service.detectFramework(tmpDir);
      expect(detection.framework).toBe('FastAPI');
      expect(detection.defaultBaseUrl).toBe('http://localhost:8000');
    });
  });

  describe('scaffoldQa', () => {
    it('creates qa/ hierarchy with surface, policy, clauses, and journeys', () => {
      const created = service.scaffoldQa(tmpDir, {
        framework: 'Next.js',
        name: 'test-ecommerce',
        baseUrl: 'http://localhost:3000',
      });

      expect(created).toHaveLength(4);
      expect(fs.existsSync(path.join(tmpDir, 'qa', 'surface.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'qa', 'policy.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'qa', 'clauses', 'sample.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'qa', 'journeys', 'smoke.yaml'))).toBe(true);

      const surface = fs.readFileSync(path.join(tmpDir, 'qa', 'surface.yaml'), 'utf8');
      expect(surface).toContain('test-ecommerce');
      expect(surface).toContain('Next.js');

      const clause = fs.readFileSync(path.join(tmpDir, 'qa', 'clauses', 'sample.md'), 'utf8');
      expect(clause).toContain('sacred: true');
    });
  });

  describe('verify & GitHub Actions annotations', () => {
    it('generates GitHub Actions CI annotations for sacred clause failures', async () => {
      service.scaffoldQa(tmpDir);

      // Verify against non-existent port to simulate server down
      const result = await service.verify(tmpDir, {
        url: 'http://127.0.0.1:59999', // offline
        ci: true,
      });

      expect(result.passed).toBe(false);
      expect(result.sacredViolations).toBeGreaterThan(0);
      expect(result.annotations.length).toBeGreaterThan(0);
      expect(result.annotations[0]).toContain('::error file=');
      expect(result.annotations[0]).toContain('title=Sacred Clause Failure');
    });
  });

  describe('explore', () => {
    it('extracts links and buttons and generates draft spec files', async () => {
      const outDir = path.join(tmpDir, 'qa');
      const result = await service.explore('http://localhost:3000', {
        outDir,
        dryRun: false,
      });

      expect(result.routesDiscovered.length).toBeGreaterThan(0);
      expect(result.clausesGenerated.length).toBeGreaterThan(0);
      expect(result.journeysGenerated.length).toBeGreaterThan(0);

      expect(fs.existsSync(result.clausesGenerated[0].filePath)).toBe(true);
      expect(fs.existsSync(result.journeysGenerated[0].filePath)).toBe(true);
    });
  });

  describe('align', () => {
    it('evaluates route alignment and coverage score', async () => {
      service.scaffoldQa(tmpDir);

      const result = await service.align(tmpDir, {
        pr: '142',
      });

      expect(result.totalClauses).toBeGreaterThanOrEqual(1);
      expect(result.coveragePct).toBeDefined();
      expect(result.score).toBeGreaterThan(0);
      expect(result.message).toBeDefined();
    });
  });

  describe('heal', () => {
    it('proposes and applies selector patches when policy allows', async () => {
      service.scaffoldQa(tmpDir);

      // Add a fragile selector to a journey
      const journeyFile = path.join(tmpDir, 'qa', 'journeys', 'fragile.yaml');
      fs.writeFileSync(
        journeyFile,
        `id: fragile-journey\nintent: Checkout\ncovers: [sample-smoke]\nsteps:\n  - click: "#btn-123456"`,
      );

      const result = await service.heal(tmpDir, {
        apply: true,
      });

      expect(result.policyAllowed).toBe(true);
      expect(result.proposals.length).toBeGreaterThan(0);
      expect(result.appliedCount).toBe(1);

      const updated = fs.readFileSync(journeyFile, 'utf8');
      expect(updated).toContain('button[type="submit"]');
    });
  });
});
