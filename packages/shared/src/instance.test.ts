import { describe, expect, it } from 'vitest';
import { instanceStatusSchema } from './instance.js';

describe('instanceStatusSchema', () => {
  it('rejects unknown keys so nothing extra leaks into the public status', () => {
    const result = instanceStatusSchema.strict().safeParse({
      name: 'BokyDo',
      version: '0.0.0',
      setupComplete: false,
      passwordMinLength: 12,
      registrationOpen: false,
      emailEnabled: false,
      passkeysAvailable: false,
      adminPassphrase: 'nope',
    });
    expect(result.success).toBe(false);
  });
});
