import type { TaskBoard } from '@agent-room/shared';

/**
 * Backend-neutral persistence operations for task-board state.
 *
 * Task state-machine rules stay outside this interface.
 * Implementations provide durable board storage, concurrency,
 * and the room-discovery index used by periodic board review.
 */
export interface TaskBoardStore {
  getTaskBoard(code: string): Promise<TaskBoard | null>;

  mutateTaskBoard(
    code: string,
    mutator: (current: TaskBoard) => TaskBoard
  ): Promise<TaskBoard>;

  clearTaskBoard(code: string): Promise<void>;

  registerBoardRoom(code: string): Promise<void>;

  unregisterBoardRoom(code: string): Promise<void>;

  listBoardRooms(): Promise<string[]>;
}
