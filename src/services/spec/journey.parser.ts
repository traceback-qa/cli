import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { Journey, JourneyStep } from './spec.types.js';

export class JourneyParser {
  private static readonly KNOWN_ACTIONS = new Set([
    'goto',
    'navigate',
    'click',
    'fill',
    'type',
    'assert',
    'wait',
    'sleep',
    'press',
    'screenshot',
    'scroll',
    'hover',
    'select',
    'check',
    'uncheck',
    'drag_and_drop',
    'upload',
  ]);

  public parseFile(filePath: string): Journey {
    const content = fs.readFileSync(filePath, 'utf8');
    const slugFallback = path.basename(filePath, path.extname(filePath));
    return this.parseContent(content, filePath, slugFallback);
  }

  public parseContent(content: string, filePath?: string, slugFallback?: string): Journey {
    const rawData = yaml.parse(content);
    if (!rawData || typeof rawData !== 'object') {
      throw new Error(`Invalid journey specification: expected YAML dictionary`);
    }

    // 1. Determine slug
    const rawSlug =
      rawData.slug ||
      rawData.id ||
      slugFallback ||
      this.deriveSlugFromIntent(rawData.intent || '') ||
      'unnamed-journey';
    const slug = this.normalizeSlug(String(rawSlug));

    // 2. Intent
    const intent = String(rawData.intent || rawData.description || `Journey for ${slug}`);

    // 3. Covers (clause slugs)
    const coversRaw = rawData.covers || rawData.clauses || [];
    const covers = this.parseListField(coversRaw);

    // 4. Probes
    const probesRaw = rawData.probes || ['visual', 'dom'];
    const probes = this.parseListField(probesRaw).map((p) => p.toLowerCase());

    // 5. Viewports
    const viewports = this.parseListField(rawData.viewports);

    // 6. Steps
    const stepsRaw = rawData.steps || [];
    const steps = this.parseSteps(stepsRaw);

    // 7. Lane & Tags
    const lane = rawData.lane ? String(rawData.lane) : undefined;
    const tags = this.parseListField(rawData.tags);
    const enabled = rawData.enabled !== false;

    // 8. Extra metadata
    const knownKeys = new Set([
      'slug',
      'id',
      'intent',
      'description',
      'covers',
      'clauses',
      'probes',
      'viewports',
      'steps',
      'lane',
      'tags',
      'enabled',
    ]);
    const metadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawData)) {
      if (!knownKeys.has(k)) {
        metadata[k] = v;
      }
    }

    return {
      slug,
      intent,
      covers,
      probes,
      viewports,
      steps,
      lane,
      tags,
      enabled,
      filePath,
      metadata,
    };
  }

  public parseDirectory(dirPath: string): Journey[] {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return [];
    }

    const journeys: Journey[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        journeys.push(...this.parseDirectory(fullPath));
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))
      ) {
        if (entry.name.startsWith('.')) continue;
        journeys.push(this.parseFile(fullPath));
      }
    }

    return journeys.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private parseSteps(stepsRaw: unknown[]): JourneyStep[] {
    const steps: JourneyStep[] = [];
    if (!Array.isArray(stepsRaw)) return steps;

    for (const item of stepsRaw) {
      if (typeof item === 'string') {
        const step = this.parseStringStep(item);
        if (step) steps.push(step);
      } else if (item && typeof item === 'object') {
        const step = this.parseDictStep(item as Record<string, unknown>);
        if (step) steps.push(step);
      }
    }

    return steps;
  }

  private parseDictStep(data: Record<string, unknown>): JourneyStep | null {
    if ('action' in data) {
      const action = String(data.action).toLowerCase();
      const target = data.target ? String(data.target) : undefined;
      const value = data.value ? String(data.value) : undefined;
      const assertion = data.assertion ? String(data.assertion) : undefined;
      const timeoutMs = typeof data.timeout_ms === 'number' ? data.timeout_ms : undefined;
      const reserved = new Set(['action', 'target', 'value', 'assertion', 'timeout_ms']);
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!reserved.has(k)) params[k] = v;
      }
      return { action, target, value, assertion, timeoutMs, params };
    }

    for (const actionName of JourneyParser.KNOWN_ACTIONS) {
      if (actionName in data) {
        const val = data[actionName];
        if (actionName === 'assert') {
          return {
            action: 'assert',
            assertion: val !== undefined ? String(val) : undefined,
            params: Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'assert')),
          };
        } else if (['fill', 'type'].includes(actionName) && val && typeof val === 'object') {
          const valObj = val as Record<string, unknown>;
          const target = String(valObj.target || valObj.selector || '');
          const value = String(valObj.value || valObj.text || '');
          const reserved = new Set(['target', 'selector', 'value', 'text']);
          const params: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(valObj)) {
            if (!reserved.has(k)) params[k] = v;
          }
          return { action: actionName, target, value, params };
        } else {
          return {
            action: actionName,
            target: val !== undefined ? String(val) : undefined,
            value: data.value ? String(data.value) : undefined,
            assertion: data.assertion ? String(data.assertion) : undefined,
            params: Object.fromEntries(
              Object.entries(data).filter(([k]) => !['action', 'value', 'assertion', actionName].includes(k)),
            ),
          };
        }
      }
    }

    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0]) {
      const k = keys[0];
      const v = data[k];
      return { action: k.toLowerCase(), target: v !== undefined ? String(v) : undefined };
    }

    return null;
  }

  private parseStringStep(text: string): JourneyStep | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const parts = trimmed.split(/\s+(.*)/s);
    if (!parts[0]) return null;
    const action = parts[0].toLowerCase();
    const rest = parts[1] ? parts[1].trim() : undefined;

    if (action === 'assert') {
      return { action: 'assert', assertion: rest ? rest.replace(/^["']|["']$/g, '') : undefined };
    }
    return { action, target: rest ? rest.replace(/^["']|["']$/g, '') : undefined };
  }

  private deriveSlugFromIntent(intent: string): string {
    return this.normalizeSlug(intent.slice(0, 50));
  }

  private normalizeSlug(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
  }

  private parseListField(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value.split(',').map((v) => v.trim()).filter(Boolean);
    }
    return [String(value).trim()];
  }
}
