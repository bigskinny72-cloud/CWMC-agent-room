import type { Message } from '@agent-room/shared';

/**
 * Backend-neutral durable message storage.
 *
 * Business rules such as mute checks, turn gating, metadata enrichment,
 * and system-message policy remain outside this interface.
 *
 * fromIndex is the absolute number of messages already consumed, not a
 * retained-list index.
 *
 * getMessageTotalCount returns null when the backend has no absolute
 * counter for the room, preserving legacy-room compatibility.
 */
export interface MessageStore {
  appendMessage(
    code: string,
    message: Message,
    roomCreatedAt: number,
  ): Promise<void>;

  listMessages(
    code: string,
    fromIndex: number,
  ): Promise<Message[]>;

  getMessageTotalCount(
    code: string,
  ): Promise<number | null>;
}
