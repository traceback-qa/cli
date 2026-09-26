import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { PolicyConfig, SurfaceConfig } from './spec.types.js';

export class PolicyParser {
  public static readonly DEFAULT_BLOCK_ON = ['sacred_failure', 'security_finding', 'bug'];
  public static readonly DEFAULT_WARN_ON = ['visual_drift', 'a11y_finding', 'perf_regression'];
  public static readonly DEFAULT_OVERRIDE_WHO = ['CODEOWNERS', 'admin', 'lead'];
  public static readonly DEFAULT_OVERRIDE_WHERE = ['pr_comment', 'slack'];
  public static readonly DEFAULT_IGNORE_PATHS = [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    'coverage/**',
  ];
  public static readonly DEFAULT_PREVIEW_URLS = [
    'https://*.vercel.app',
    'https://*.railway.app',
    'https://*.preview.internal',
  ];
  public static readonly DEFAULT_PROD_URLS = ['https://app.*', 'https://*.*'];
  public static readonly DEFAULT_LOCAL_URLS = ['http://localhost:*', 'http://127.0.0.1:*'];

  public parsePolicyFile(filePath: string): PolicyConfig {
    if (!fs.existsSync(filePath)) {
      return this.getDefaultPolicy();
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return this.parsePolicyContent(content);
  }

  public parsePolicyContent(content: string): PolicyConfig {
    if (!content || !content.trim()) {
      return this.getDefaultPolicy();
    }

    try {
      const data = yaml.parse(content);
      if (!data || typeof data !== 'object') {
        return { ...this.getDefaultPolicy(), rawYaml: content };
      }

      const mergeData = data.merge || {};
      const healData = data.heal || {};
      const overrideData = data.override || {};

      return {
        merge: {
          blockOn: this.parseList(mergeData.block_on || mergeData.blockOn, PolicyParser.DEFAULT_BLOCK_ON),
          warnOn: this.parseList(mergeData.warn_on || mergeData.warnOn, PolicyParser.DEFAULT_WARN_ON),
        },
        heal: {
          locators: healData.locators !== false,
          assertions: Boolean(healData.assertions),
          appCode: Boolean(healData.app_code || healData.appCode),
          minConfidence:
            typeof healData.min_confidence === 'number'
              ? healData.min_confidence
              : typeof healData.minConfidence === 'number'
                ? healData.minConfidence
                : 0.85,
        },
        override: {
          who: this.parseList(overrideData.who, PolicyParser.DEFAULT_OVERRIDE_WHO),
          where: this.parseList(overrideData.where, PolicyParser.DEFAULT_OVERRIDE_WHERE),
        },
        rawYaml: content,
      };
    } catch {
      return { ...this.getDefaultPolicy(), rawYaml: content };
    }
  }

  public parseSurfaceFile(filePath: string, repoNameFallback = 'default'): SurfaceConfig {
    if (!fs.existsSync(filePath)) {
      return this.getDefaultSurface(repoNameFallback);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return this.parseSurfaceContent(content, repoNameFallback);
  }

  public parseSurfaceContent(content: string, repoNameFallback = 'default'): SurfaceConfig {
    if (!content || !content.trim()) {
      return this.getDefaultSurface(repoNameFallback);
    }

    try {
      const data = yaml.parse(content);
      if (!data || typeof data !== 'object') {
        return this.getDefaultSurface(repoNameFallback);
      }

      const name = String(data.name || repoNameFallback);
      const urlPatterns = data.base_url_patterns || data.baseUrlPatterns || {};

      const baseUrlPatterns = {
        preview: this.parseList(urlPatterns.preview, PolicyParser.DEFAULT_PREVIEW_URLS),
        prod: this.parseList(urlPatterns.prod, PolicyParser.DEFAULT_PROD_URLS),
        local: this.parseList(urlPatterns.local, PolicyParser.DEFAULT_LOCAL_URLS),
      };

      const ignorePaths = this.parseList(
        data.ignore_paths || data.ignorePaths,
        PolicyParser.DEFAULT_IGNORE_PATHS,
      );

      const previewProvider = data.preview_provider || data.previewProvider ? String(data.preview_provider || data.previewProvider) : undefined;
      const inferredStack = data.inferred_stack || data.inferredStack ? String(data.inferred_stack || data.inferredStack) : undefined;
      const lanes = data.lanes && typeof data.lanes === 'object' ? data.lanes : {};

      const knownKeys = new Set([
        'name',
        'base_url_patterns',
        'baseUrlPatterns',
        'ignore_paths',
        'ignorePaths',
        'preview_provider',
        'previewProvider',
        'inferred_stack',
        'inferredStack',
        'lanes',
      ]);
      const metadata: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!knownKeys.has(k)) {
          metadata[k] = v;
        }
      }

      return {
        name,
        baseUrlPatterns,
        ignorePaths,
        previewProvider,
        inferredStack,
        lanes,
        metadata,
      };
    } catch {
      return this.getDefaultSurface(repoNameFallback);
    }
  }

  public parseRepoConfigs(repoPath: string): { surface: SurfaceConfig; policy: PolicyConfig } {
    const repoName = path.basename(repoPath) || 'default';

    let surfaceFile = path.join(repoPath, 'qa', 'surface.yaml');
    if (!fs.existsSync(surfaceFile)) {
      surfaceFile = path.join(repoPath, 'qa', 'surface.yml');
    }

    let policyFile = path.join(repoPath, 'qa', 'policy.yaml');
    if (!fs.existsSync(policyFile)) {
      policyFile = path.join(repoPath, 'qa', 'policy.yml');
    }

    const surface = this.parseSurfaceFile(surfaceFile, repoName);
    const policy = this.parsePolicyFile(policyFile);

    return { surface, policy };
  }

  private getDefaultPolicy(): PolicyConfig {
    return {
      merge: {
        blockOn: [...PolicyParser.DEFAULT_BLOCK_ON],
        warnOn: [...PolicyParser.DEFAULT_WARN_ON],
      },
      heal: {
        locators: true,
        assertions: false,
        appCode: false,
        minConfidence: 0.85,
      },
      override: {
        who: [...PolicyParser.DEFAULT_OVERRIDE_WHO],
        where: [...PolicyParser.DEFAULT_OVERRIDE_WHERE],
      },
    };
  }

  private getDefaultSurface(name: string): SurfaceConfig {
    return {
      name,
      baseUrlPatterns: {
        preview: [...PolicyParser.DEFAULT_PREVIEW_URLS],
        prod: [...PolicyParser.DEFAULT_PROD_URLS],
        local: [...PolicyParser.DEFAULT_LOCAL_URLS],
      },
      ignorePaths: [...PolicyParser.DEFAULT_IGNORE_PATHS],
      metadata: {},
    };
  }

  private parseList(val: unknown, fallback: string[]): string[] {
    if (val === undefined || val === null) {
      return [...fallback];
    }
    if (Array.isArray(val)) {
      return val.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof val === 'string') {
      return val.split(',').map((v) => v.trim()).filter(Boolean);
    }
    return [String(val).trim()];
  }
}
