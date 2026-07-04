import { z } from 'zod';
import { DEFAULT_API_URL } from '../../constants/urls.js';

export const GlobalConfigSchema = z.object({
  apiUrl: z.string().url().default(DEFAULT_API_URL),
  editor: z.string().optional(),
  defaultOrg: z.string().optional(),
  defaultEnvironment: z.string().default('production'),
  workspaceId: z.string().optional(),
  telemetryEnabled: z.boolean().default(true),
  updateCheckEnabled: z.boolean().default(true),
  lastUpdateCheck: z.number().optional(),
});

export const ProjectConfigSchema = z.object({
  projectId: z.string().optional(),
  environment: z.string().optional(),
  org: z.string().optional(),
  custom: z.record(z.unknown()).optional(),
});

export const ResolvedConfigSchema = GlobalConfigSchema.extend({
  project: ProjectConfigSchema.optional(),
});

export type GlobalConfigInput = z.input<typeof GlobalConfigSchema>;
export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
export type ResolvedConfigInput = z.input<typeof ResolvedConfigSchema>;
