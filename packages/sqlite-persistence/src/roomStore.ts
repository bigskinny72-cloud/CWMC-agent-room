import type { Room } from '@agent-room/shared';
import type { RoomStore } from '@agent-room/persistence';

import {
  ConcurrencyError,
  casRoom as casStoredRoom,
  getRoom as getStoredRoom,
} from './rooms.js';

const CAS_MAX_ATTEMPTS = 3;

/**
 * SQLite implementation of the backend-neutral RoomStore contract.
 *
 * Business logic supplies the mutator. This adapter handles:
 * - loading current room state
 * - running the mutator
 * - atomic version-checked SQLite CAS
 * - retrying stale writes
 */
export const sqliteRoomStore: RoomStore = {
  async getRoom(code: string): Promise<Room> {
    return getStoredRoom(code);
  },

  async casRoom(
    code: string,
    mutator: (current: Room) => Room
  ): Promise<Room> {
    let lastError: unknown;

    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
      const current = getStoredRoom(code);

      let next: Room;
      try {
        next = mutator(current);
      } catch (error) {
        if (error instanceof ConcurrencyError) {
          lastError = error;
          continue;
        }

        throw error;
      }

      try {
        return casStoredRoom(code, current.version, next);
      } catch (error) {
        if (error instanceof ConcurrencyError) {
          lastError = error;
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof ConcurrencyError
      ? lastError
      : new ConcurrencyError();
  },
};
