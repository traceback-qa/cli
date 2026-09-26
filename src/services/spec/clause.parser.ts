import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'yaml';
import type { Clause } from './spec.types.js';

export class ClauseParser {
  private static readonly FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  private static readonly TASK_LIST_REGEX = /^\s*[-*]\s*\[[ xX]\]\s+(.*)$/gm;
  private static readonly BULLET_REGEX = /^\s*[-*]\s+(.*)$/gm;
  private static readonly HEADING_REGEX = /^#+\s+(.*)$/m;
  private static readonly SACRED_TAG_REGEX = /(?:^|\s)#sacred\b/i;

  public parseFile(filePath: string): Clause {
    const content = fs.readFileSync(filePath, 'utf8');
    const slugFallback = path.basename(filePath, path.extname(filePath));
    return this.parseContent(content, filePath, slugFallback);
  }

  public parseContent(content: string, filePath?: string, slugFallback?: string): Clause {
    const { frontmatter, body } = this.extractFrontmatterAndBody(content);

    // 1. Determine slug
    const rawSlug =
      frontmatter.slug ||
      frontmatter.id ||
      slugFallback ||
      this.deriveSlugFromBody(body) ||
      'unnamed-clause';
    const slug = this.normalizeSlug(String(rawSlug));

    // 2. Extract title
    let title = frontmatter.title;
    if (!title) {
      const headingMatch = ClauseParser.HEADING_REGEX.exec(body);
      if (headingMatch && headingMatch[1]) {
        title = headingMatch[1].trim();
      } else {
        title = slug;
      }
    }

    // 3. Detect #sacred flag
    const tags = this.parseListField(frontmatter.tags);
    const sacredInTags = tags.some((t) => t.toLowerCase().replace('#', '') === 'sacred');
    const sacredInFrontmatter = Boolean(frontmatter.sacred);
    const sacredInBody = ClauseParser.SACRED_TAG_REGEX.test(body);
    const sacred = sacredInFrontmatter || sacredInTags || sacredInBody;

    // 4. Extract other fields
    const lane = frontmatter.lane ? String(frontmatter.lane) : undefined;
    const viewports = this.parseListField(frontmatter.viewports);
    const applies = this.parseListField(frontmatter.applies);
    const sourceUri = frontmatter.source || frontmatter.source_uri ? String(frontmatter.source || frontmatter.source_uri) : undefined;

    // 5. Compute body SHA-256 hash
    const bodyClean = body.trim();
    const bodyHash = crypto.createHash('sha256').update(bodyClean, 'utf8').digest('hex');

    // 6. Extract acceptance criteria
    const acceptanceCriteria = this.extractAcceptanceCriteria(body);

    // 7. Collect remaining metadata
    const knownKeys = new Set([
      'slug',
      'id',
      'title',
      'sacred',
      'lane',
      'tags',
      'viewports',
      'applies',
      'source',
      'source_uri',
    ]);
    const metadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(frontmatter)) {
      if (!knownKeys.has(k)) {
        metadata[k] = v;
      }
    }

    return {
      slug,
      title: String(title),
      body: bodyClean,
      bodyHash,
      sacred,
      lane,
      tags,
      viewports,
      applies,
      sourceUri,
      acceptanceCriteria,
      filePath,
      metadata,
    };
  }

  public parseDirectory(dirPath: string): Clause[] {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return [];
    }

    const clauses: Clause[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        clauses.push(...this.parseDirectory(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (entry.name.startsWith('.') || ['readme.md', 'summary.md'].includes(entry.name.toLowerCase())) {
          continue;
        }
        clauses.push(this.parseFile(fullPath));
      }
    }

    return clauses.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private extractFrontmatterAndBody(content: string): { frontmatter: Record<string, any>; body: string } {
    const match = ClauseParser.FRONTMATTER_REGEX.exec(content);
    if (match && match[1]) {
      const rawYaml = match[1];
      const body = content.slice(match[0].length);
      try {
        const data = yaml.parse(rawYaml);
        if (data && typeof data === 'object') {
          return { frontmatter: data, body };
        }
      } catch {
        // Fall back to no frontmatter if parsing fails
      }
    }
    return { frontmatter: {}, body: content };
  }

  private deriveSlugFromBody(body: string): string {
    const headingMatch = ClauseParser.HEADING_REGEX.exec(body);
    if (headingMatch && headingMatch[1]) {
      return this.normalizeSlug(headingMatch[1]);
    }
    return '';
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

  private extractAcceptanceCriteria(body: string): string[] {
    const criteria: string[] = [];

    // 1. Checklist items: `- [ ] ...` or `- [x] ...`
    const taskMatches = [...body.matchAll(ClauseParser.TASK_LIST_REGEX)];
    if (taskMatches.length > 0) {
      for (const m of taskMatches) {
        if (m[1]) {
          const cleaned = m[1].trim();
          if (cleaned) criteria.push(cleaned);
        }
      }
      return criteria;
    }

    // 2. Acceptance Criteria section
    const sectionPattern = /##+\s*(?:Acceptance Criteria|Requirements|Contract|Clauses)([\s\S]*?)(?=\n##+|\Z)/i;
    const sectionMatch = sectionPattern.exec(body);
    if (sectionMatch && sectionMatch[1]) {
      const sectionText = sectionMatch[1];
      const bulletMatches = [...sectionText.matchAll(ClauseParser.BULLET_REGEX)];
      for (const m of bulletMatches) {
        if (m[1]) {
          const cleaned = m[1].trim();
          if (cleaned) criteria.push(cleaned);
        }
      }
      if (criteria.length > 0) return criteria;
    }

    // 3. Fallback bullets
    const allBullets = [...body.matchAll(ClauseParser.BULLET_REGEX)];
    if (allBullets.length > 0) {
      for (const m of allBullets) {
        if (m[1]) {
          const cleaned = m[1].trim();
          if (cleaned) criteria.push(cleaned);
        }
      }
      return criteria;
    }

    // 4. Non-empty lines
    for (const line of body.split('\n')) {
      const lineStr = line.trim();
      if (lineStr && !lineStr.startsWith('#')) {
        criteria.push(lineStr);
      }
    }

    return criteria;
  }
}
