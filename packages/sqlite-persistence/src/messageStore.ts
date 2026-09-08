import type { Message } from '@agent-room/shared';
import type { MessageStore } from '@agent-room/persistence';

import {
  appendStoredMessage,
  listStoredMessages,
  getMessageTotalCount,
} from './messages.js';

export function createSqliteMessageStore(): MessageStore {
  return {
    async appendMessage(
      code: string,
      message: Message,
      _roomCreatedAt: number,
    ): Promise<void> {
      appendStoredMessage(code, message);
    },

    async listMessages(
      code: string,
      fromIndex: number,
    ): Promise<Message[]> {
      return listStoredMessages(code, fromIndex);
    },

    async getMessageTotalCount(
      code: string,
    ): Promise<number | null> {
      return getMessageTotalCount(code);
    },
  };
}
