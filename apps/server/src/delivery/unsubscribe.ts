import { NOTIFICATION_EVENTS, type NotificationEvent } from '@bokydo/shared';
import { safeEqual, tokenId } from '../auth/tokens.js';

export type UnsubscribeTopic = Exclude<NotificationEvent, 'security'> | 'digest';
const TOPICS = new Set<string>([...NOTIFICATION_EVENTS.filter((e) => e !== 'security'), 'digest']);

/**
 * A link that turns off one kind of email for one user, without signing in. It's an HMAC of the
 * user and topic, so it can't be forged or pointed at anyone else; it does nothing else.
 */
export function unsubscribeToken(key: Buffer, userId: string, topic: UnsubscribeTopic): string {
  return `${userId}.${topic}.${tokenId(key, 'unsubscribe', `${userId}:${topic}`)}`;
}

export function readUnsubscribeToken(
  key: Buffer,
  token: string,
): { userId: string; topic: UnsubscribeTopic } | null {
  const [userId, topic, sig, ...rest] = token.split('.');
  if (!userId || !topic || !sig || rest.length || !TOPICS.has(topic)) return null;
  const expected = tokenId(key, 'unsubscribe', `${userId}:${topic}`);
  return safeEqual(sig, expected) ? { userId, topic: topic as UnsubscribeTopic } : null;
}
