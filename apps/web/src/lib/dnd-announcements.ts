import type { Announcements, UniqueIdentifier } from '@dnd-kit/core';

const MAX_NAME = 60;
const quoted = (text: string) =>
  `“${text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text}”`;

/** A day as a person would say it: "Wednesday 7 October". */
export function dayName(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/** A task's title as it is read out. */
export const taskName = (title: string) => quoted(title);

/**
 * What a screen reader hears while a task is dragged by keyboard. dnd-kit announces raw ids by
 * default ("Draggable item 2f04… was moved over droppable area 9c1a…"), which tells nobody
 * anything; `name` turns an id into words, or returns null for something unknown.
 */
export function announcementsFor(name: (id: UniqueIdentifier) => string | null): Announcements {
  const label = (id: UniqueIdentifier) => name(id) ?? 'the item';
  return {
    onDragStart: ({ active }) => `Picked up ${label(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${label(active.id)} is over ${label(over.id)}.`
        : `${label(active.id)} is not over a place it can go.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${label(active.id)} on ${label(over.id)}.`
        : `${label(active.id)} was dropped where it started.`,
    onDragCancel: ({ active }) => `Cancelled. ${label(active.id)} was not moved.`,
  };
}
