import { queryOptions } from '@tanstack/react-query';
import { api } from './api.js';

/** A calendar feed as the owner sees it. The link itself is never part of this. */
export interface CalendarFeed {
  id: string;
  kind: 'project' | 'filter';
  targetId: string | null;
  /** Null when the project or filter is gone or no longer visible to the owner. */
  targetName: string | null;
  showDescriptions: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export const calendarFeedsQuery = queryOptions({
  queryKey: ['calendar-feeds'],
  queryFn: async () =>
    (await api<{ feeds: CalendarFeed[] }>('GET', '/api/v1/calendar-feeds')).feeds,
});

/**
 * The full link to give a calendar app. The server returns a path when the instance has no public
 * URL set, so resolve it against the address the user is on now.
 */
export function feedHref(url: string, origin: string = window.location.origin): string {
  return new URL(url, origin).href;
}
