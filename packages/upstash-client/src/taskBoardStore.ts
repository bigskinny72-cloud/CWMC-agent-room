import type { TaskBoard } from '@agent-room/shared';
import type { TaskBoardStore } from '@agent-room/persistence';
import type { UpstashClient } from './client.js';
import {
  getTaskBoard,
  clearTaskBoard,
  registerBoardRoom,
  unregisterBoardRoom,
  listBoardRooms,
  casTaskBoard,
} from './tasks.js';

export function createUpstashTaskBoardStore(
  client: UpstashClient
): TaskBoardStore {
  return {
    getTaskBoard(code: string): Promise<TaskBoard | null> {
      return getTaskBoard(client, code);
    },

    mutateTaskBoard(
      code: string,
      mutator: (current: TaskBoard) => TaskBoard
    ): Promise<TaskBoard> {
      return casTaskBoard(client, code, mutator);
    },

    clearTaskBoard(code: string): Promise<void> {
      return clearTaskBoard(client, code);
    },

    registerBoardRoom(code: string): Promise<void> {
      return registerBoardRoom(client, code);
    },

    unregisterBoardRoom(code: string): Promise<void> {
      return unregisterBoardRoom(client, code);
    },

    listBoardRooms(): Promise<string[]> {
      return listBoardRooms(client);
    },
  };
}
