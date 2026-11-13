import { describe, it, expect } from 'vitest';
import { openUrl } from '../../src/platform/open-url.js';

describe('openUrl', () => {
  it('rejects non-http(s) and malformed URLs without spawning anything', async () => {
    expect(await openUrl('file:///etc/passwd')).toBe(false);
    expect(await openUrl('javascript:alert(1)')).toBe(false);
    expect(await openUrl('not a url')).toBe(false);
  });
});
