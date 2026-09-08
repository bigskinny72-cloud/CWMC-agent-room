import type { TaskBoard } from '@agent-room/shared';
import type { TaskBoardStore } from '@agent-room/persistence';
import {
  getStoredTaskBoard,
  mutateStoredTaskBoard,
  clearStoredTaskBoard,
  registerBoardRoom,
  unregisterBoardRoom,
  listBoardRooms,
} from './tasks.js';

export function createSqliteTaskBoardStore(): TaskBoardStore {
  return {
    async getTaskBoard(code: string): Promise<TaskBoard | null> {
      return getStoredTaskBoard(code);
    },

    async mutateTaskBoard(
      code: string,
      mutator: (current: TaskBoard) => TaskBoard
    ): Promise<TaskBoard> {
      return mutateStoredTaskBoard(code, mutator);
    },

    async clearTaskBoard(code: string): Promise<void> {
      clearStoredTaskBoard(code);
    },

    async registerBoardRoom(code: string): Promise<void> {
      registerBoardRoom(code);
    },

    async unregisterBoardRoom(code: string): Promise<void> {
      unregisterBoardRoom(code);
    },

    async listBoardRooms(): Promise<string[]> {
      return listBoardRooms();
    },
  };
}
