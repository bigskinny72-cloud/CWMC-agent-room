import type { Room } from '@agent-room/shared';
import { ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { RoomStore } from '@agent-room/persistence';

import type { UpstashClient } from './client.js';
import { ConcurrencyError, RoomNotFoundError } from './errors.js';

const CAS_MAX_ATTEMPTS = 3;

function roomKey(code: string): string {
  return `room:${code}`;
}

export function createUpstashRoomStore(client: UpstashClient): RoomStore {
  return {
    async createRoom(room: Room): Promise<Room> {
      await client.command([
        'SET',
        roomKey(room.code),
        JSON.stringify(room),
        'EX',
        ROOM_TTL_SECONDS,
      ]);

      return room;
    },

    async getRoom(code: string): Promise<Room> {
      const raw = await client.command<string | null>([
        'GET',
        roomKey(code),
      ]);

      if (raw === null || raw === undefined) {
        throw new RoomNotFoundError(code);
      }

      return JSON.parse(raw) as Room;
    },

    async casRoom(
      code: string,
      mutator: (current: Room) => Room
    ): Promise<Room> {
      let lastError: unknown;

      for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
        const current = await this.getRoom(code);

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

        next.version = current.version + 1;

        await client.command([
          'SET',
          roomKey(code),
          JSON.stringify(next),
          'KEEPTTL',
        ]);

        return next;
      }

      throw lastError instanceof ConcurrencyError
        ? lastError
        : new ConcurrencyError();
    },
  };
}
