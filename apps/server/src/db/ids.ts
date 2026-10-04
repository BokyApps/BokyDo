import { v7 } from 'uuid';

/** All primary keys are UUIDv7: time-ordered but unguessable. */
export function newId(): string {
  return v7();
}
