import { eq } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { Database } from '../db/client.js';
import { instanceSettings } from '../db/schema.js';

/**
 * Break-glass for a mistyped public URL: once set, browsers must send that exact Origin, so a
 * wrong value locks every browser out. Clearing it falls back to same-host checks.
 */
export async function clearPublicUrl(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(instanceSettings).where(eq(instanceSettings.key, 'instance.publicUrl'));
    await audit(tx, { action: 'settings.public_url_cleared_cli', actorType: 'cli' });
  });
}
