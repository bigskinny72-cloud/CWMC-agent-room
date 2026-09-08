import type { TaskBoard } from '@agent-room/shared';
import { ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { TaskBoardStore } from '@agent-room/persistence';
import { ConcurrencyError } from '@agent-room/persistence';
import type { UpstashClient } from './client.js';

const CAS_MAX_ATTEMPTS = 6;
const BOARD_ROOMS_KEY = 'task-board:rooms';

function taskBoardKey(code: string): string {
  return `task-board:${code}`;
}

const CAS_SCRIPT =
  "local cur = redis.call('GET', KEYS[1])\n" +
  "if ARGV[1] == 'absent' then\n" +
  "  if cur then return 0 end\n" +
  "else\n" +
  "  if cur ~= ARGV[2] then return 0 end\n" +
  "end\n" +
  "redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))\n" +
  "return 1";

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export function createUpstashTaskBoardStore(
  client: UpstashClient
): TaskBoardStore {
  return {
    async getTaskBoard(code: string): Promise<TaskBoard | null> {
      const raw = await client.command<string | null>([
        'GET',
        taskBoardKey(code),
      ]);

      if (raw === null || raw === undefined) {
        return null;
      }

      try {
        return JSON.parse(raw) as TaskBoard;
      } catch {
        return null;
      }
    },

    async mutateTaskBoard(
      code: string,
      mutator: (current: TaskBoard) => TaskBoard
    ): Promise<TaskBoard> {
      let lastError: unknown;

      for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
        const raw = await client.command<string | null>([
          'GET',
          taskBoardKey(code),
        ]);

        let current: TaskBoard;

        if (raw === null || raw === undefined) {
          current = { code, tasks: [], version: 0 };
        } else {
          try {
            current = JSON.parse(raw) as TaskBoard;
          } catch {
            current = { code, tasks: [], version: 0 };
          }
        }

        let next: TaskBoard;

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

        const result = await client.command<number>([
          'EVAL',
          CAS_SCRIPT,
          '1',
          taskBoardKey(code),
          raw === null || raw === undefined ? 'absent' : 'present',
          raw ?? '',
          JSON.stringify(next),
          String(ROOM_TTL_SECONDS),
        ]);

        if (Number(result) === 1) {
          return next;
        }

        lastError = new ConcurrencyError();
        await sleep(20 + Math.floor(Math.random() * 50));
      }

      throw lastError instanceof ConcurrencyError
        ? lastError
        : new ConcurrencyError();
    },

    async clearTaskBoard(code: string): Promise<void> {
      await client.command(['DEL', taskBoardKey(code)]);
      await client.command(['SREM', BOARD_ROOMS_KEY, code]).catch(() => {});
    },

    async registerBoardRoom(code: string): Promise<void> {
      await client.pipeline([
        ['SADD', BOARD_ROOMS_KEY, code],
        ['EXPIRE', BOARD_ROOMS_KEY, ROOM_TTL_SECONDS],
      ]);
    },

    async unregisterBoardRoom(code: string): Promise<void> {
      await client.command(['SREM', BOARD_ROOMS_KEY, code]);
    },

    async listBoardRooms(): Promise<string[]> {
      const members = await client.command<string[] | null>([
        'SMEMBERS',
        BOARD_ROOMS_KEY,
      ]);

      return Array.isArray(members) ? members : [];
    },
  };
}
