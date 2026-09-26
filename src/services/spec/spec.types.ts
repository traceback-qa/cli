/**
 * Traceback V2 Spec-Driven Development Domain Types.
 * Matches specifications for qa/surface.yaml, qa/policy.yaml, qa/clauses/*.md, and qa/journeys/*.yaml.
 */

export interface Clause {
  slug: string;
  title: string;
  body: string;
  bodyHash: string;
  sacred: boolean;
  lane?: string;
  tags: string[];
  viewports: string[];
  applies: string[];
  sourceUri?: string;
  acceptanceCriteria: string[];
  filePath?: string;
  metadata: Record<string, unknown>;
}

export interface JourneyStep {
  action: string;
  target?: string;
  value?: string;
  assertion?: string;
  timeoutMs?: number;
  params?: Record<string, unknown>;
}

export interface Journey {
  slug: string;
  intent: string;
  covers: string[];
  probes: string[];
  viewports: string[];
  steps: JourneyStep[];
  lane?: string;
  tags: string[];
  enabled: boolean;
  filePath?: string;
  metadata: Record<string, unknown>;
}

export interface BaseUrlPatterns {
  local: string[];
  preview: string[];
  prod: string[];
}

export interface SurfaceConfig {
  name: string;
  baseUrlPatterns: BaseUrlPatterns;
  ignorePaths: string[];
  previewProvider?: string;
  inferredStack?: string;
  lanes?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface HealPolicy {
  locators: boolean;
  assertions: boolean;
  appCode: boolean;
  minConfidence: number;
}

export interface MergePolicy {
  blockOn: string[];
  warnOn: string[];
}

export interface OverridePolicy {
  who: string[];
  where: string[];
}

export interface PolicyConfig {
  merge: MergePolicy;
  heal: HealPolicy;
  override: OverridePolicy;
  rawYaml?: string;
}

export interface ProjectSpecs {
  projectRoot: string;
  surface: SurfaceConfig;
  policy: PolicyConfig;
  clauses: Clause[];
  journeys: Journey[];
}

export interface ViewportDefinition {
  name: 'desktop' | 'mobile' | string;
  width: number;
  height: number;
}

export interface StepResult {
  action: string;
  target?: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

export interface Finding {
  type: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  clauseSlug?: string;
  journeySlug?: string;
  filePath?: string;
  line?: number;
}

export interface JourneyRunResult {
  journeySlug: string;
  journeyIntent: string;
  coveredClauses: string[];
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  viewport: ViewportDefinition;
  steps: StepResult[];
  findings: Finding[];
  sacredViolation?: boolean;
}

export interface VerificationSummary {
  totalJourneys: number;
  passedJourneys: number;
  failedJourneys: number;
  totalClauses: number;
  coveredClauses: number;
  sacredViolations: number;
  findings: Finding[];
  runs: JourneyRunResult[];
  passed: boolean;
  durationMs: number;
  annotations: string[];
  targetUrl: string;
}

export interface VerifyOptions {
  target?: string;
  url?: string;
  ci?: boolean;
  json?: boolean;
  viewport?: 'desktop' | 'mobile' | 'all';
  clause?: string;
  journey?: string;
}

export interface DiscoveredElement {
  type: 'link' | 'button' | 'input' | 'form' | 'heading';
  label: string;
  selector: string;
  href?: string;
  action?: string;
}

export interface DiscoveredRoute {
  path: string;
  url: string;
  title: string;
  elements: DiscoveredElement[];
}

export interface CrawlResult {
  baseUrl: string;
  routesDiscovered: DiscoveredRoute[];
  clausesGenerated: Array<{ slug: string; filePath: string; content: string }>;
  journeysGenerated: Array<{ slug: string; filePath: string; content: string }>;
}

export interface ExploreOptions {
  url?: string;
  outDir?: string;
  depth?: number;
  json?: boolean;
  dryRun?: boolean;
}

export interface AlignOptions {
  pr?: string | number;
  linear?: string;
  target?: string;
  ci?: boolean;
  json?: boolean;
}

export interface AlignResult {
  pr?: string | number;
  linear?: string;
  totalClauses: number;
  coveredClauses: number;
  coveragePct: number;
  uncoveredRoutes: string[];
  modifiedFiles: string[];
  score: number;
  passed: boolean;
  message: string;
}

export interface HealOptions {
  runId?: string;
  file?: string;
  apply?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface HealProposal {
  filePath: string;
  originalSelector: string;
  suggestedSelector: string;
  confidence: number;
  reason: string;
  applied: boolean;
  diff: string;
}

export interface HealResult {
  proposals: HealProposal[];
  appliedCount: number;
  policyAllowed: boolean;
  message: string;
}
