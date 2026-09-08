import {
  MAX_MESSAGES_PER_ROOM,
  ROOM_TTL_SECONDS,
  type Message,
} from '@agent-room/shared';

import type { MessageStore } from '@agent-room/persistence';
import type { UpstashClient } from './client.js';

function msgsKey(code: string): string {
  return `room-msgs:${code}`;
}

function msgCountKey(code: string): string {
  return `room-msg-count:${code}`;
}

export function createUpstashMessageStore(
  client: UpstashClient,
): MessageStore {
  return {
    async appendMessage(
      code: string,
      message: Message,
      roomCreatedAt: number,
    ): Promise<void> {
      const expireAt =
        (
          Number.isFinite(roomCreatedAt)
            ? Math.floor(roomCreatedAt / 1000)
            : Math.floor(Date.now() / 1000)
        ) + ROOM_TTL_SECONDS;

      const safe: Message =
        typeof message.text === 'string'
          ? message
          : { ...message, text: '' };

      await client.pipeline([
        ['RPUSH', msgsKey(code), JSON.stringify(safe)],
        ['INCR', msgCountKey(code)],
        ['LTRIM', msgsKey(code), -MAX_MESSAGES_PER_ROOM, -1],
        ['EXPIREAT', msgsKey(code), expireAt],
        ['EXPIREAT', msgCountKey(code), expireAt],
      ]);
    },

    async listMessages(
      code: string,
      fromIndex: number,
    ): Promise<Message[]> {
      const meta = await client.pipeline<unknown>([
        ['GET', msgCountKey(code)],
        ['LLEN', msgsKey(code)],
      ]);

      const countRaw = meta[0] as string | number | null;
      const listLen = Number(meta[1] ?? 0);

      if (listLen === 0) {
        return [];
      }

      let start: number;

      if (countRaw === null || countRaw === undefined) {
        start = fromIndex;
      } else {
        const totalCount =
          typeof countRaw === 'number'
            ? countRaw
            : parseInt(String(countRaw), 10);

        const trimmed = totalCount - listLen;
        start = fromIndex - trimmed;

        if (start < 0) {
          start = 0;
        }
      }

      if (start >= listLen) {
        return [];
      }

      const raw = await client.command<string[]>([
        'LRANGE',
        msgsKey(code),
        start,
        -1,
      ]);

      return raw.map(line => {
        const message = JSON.parse(line) as Message;

        if (typeof message.text !== 'string') {
          message.text = '';
        }

        return message;
      });
    },

    async getMessageTotalCount(
      code: string,
    ): Promise<number | null> {
      const countRaw = await client.command<unknown>([
        'GET',
        msgCountKey(code),
      ]);

      if (countRaw === null || countRaw === undefined) {
        return null;
      }

      const totalCount =
        typeof countRaw === 'number'
          ? countRaw
          : parseInt(String(countRaw), 10);

      return Number.isFinite(totalCount)
        ? totalCount
        : null;
    },
  };
}
