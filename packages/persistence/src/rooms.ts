import type { Room } from '@agent-room/shared';

/**
 * Backend-neutral persistence operations for Room state.
 *
 * Business rules do not belong here. Implementations are responsible only
 * for durable storage and concurrency semantics.
 */
export interface RoomStore {
  /**
   * Persist a newly created room.
   * Must not overwrite an existing room with the same code.
   */
  createRoom(room: Room): Promise<Room>;

  getRoom(code: string): Promise<Room>;

  casRoom(
    code: string,
    mutator: (current: Room) => Room
  ): Promise<Room>;
}
