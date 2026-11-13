import { describe, it, expect } from 'vitest';
import { z } from 'zod';

describe('MCP Tools Schema Validation', () => {
  it('validates list_tests arguments', () => {
    const schema = z.object({
      query: z.string().optional(),
      platform: z.enum(['web', 'mobile', 'all']).optional(),
    });

    const valid = schema.parse({ query: 'login', platform: 'web' });
    expect(valid.query).toBe('login');
    expect(valid.platform).toBe('web');
  });

  it('validates run_test arguments', () => {
    const schema = z.object({
      test_id: z.string().min(1),
      environment: z.string().optional().default('production'),
    });

    const parsed = schema.parse({ test_id: 'test_123' });
    expect(parsed.test_id).toBe('test_123');
    expect(parsed.environment).toBe('production');
  });

  it('validates get_run_results arguments', () => {
    const schema = z.object({
      run_id: z.string().min(1),
    });

    const parsed = schema.parse({ run_id: 'run_456' });
    expect(parsed.run_id).toBe('run_456');
  });
});
