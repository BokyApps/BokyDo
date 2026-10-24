import type { AiDecision } from '@bokydo/shared';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { aiDecisions } from '../db/schema.js';

/**
 * The decision log (PLAN §5.4): what BokyDo changed by itself, and why. The user's own rows
 * only, newest first.
 */
export async function listDecisions(
  db: Database,
  userId: string,
  limit = 50,
): Promise<AiDecision[]> {
  const rows = await db
    .select({
      id: aiDecisions.id,
      taskId: aiDecisions.taskId,
      summary: aiDecisions.summary,
      confidence: aiDecisions.confidence,
      why: aiDecisions.why,
      createdAt: aiDecisions.createdAt,
    })
    .from(aiDecisions)
    .where(eq(aiDecisions.userId, userId))
    .orderBy(desc(aiDecisions.createdAt))
    .limit(Math.max(1, Math.min(200, limit)));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
