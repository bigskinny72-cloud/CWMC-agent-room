import {
  MAX_MESSAGES_PER_ROOM,
  type Message,
} from '@agent-room/shared';

import { getDb } from './db.js';

/**
 * Persist one message using the same durable semantics as the Redis
 * RPUSH + INCR + LTRIM pipeline:
 *
 *   1. Heal missing/non-string text to ''.
 *   2. Increment the room's absolute lifetime message count.
 *   3. Use that new count as the message's absolute sequence number.
 *   4. Retain only the newest MAX_MESSAGES_PER_ROOM rows.
 *
 * The entire operation is one SQLite transaction so the counter and
 * retained message set cannot diverge.
 */
export function appendStoredMessage(
  code: string,
  message: Message,
): number {
  const db = getDb();

  const incrementCount = db.prepare(`
    INSERT INTO message_counts (code, totalCount)
    VALUES (?, 1)
    ON CONFLICT(code) DO UPDATE
    SET totalCount = totalCount + 1
  `);

  const readCount = db.prepare(`
    SELECT totalCount
    FROM message_counts
    WHERE code = ?
  `);

  const insertMessage = db.prepare(`
    INSERT INTO messages (code, seq, messageJson)
    VALUES (?, ?, ?)
  `);

  const trimMessages = db.prepare(`
    DELETE FROM messages
    WHERE code = ?
      AND seq <= ?
  `);

  const tx = db.transaction(() => {
    const safe: Message =
      typeof message.text === 'string'
        ? message
        : { ...message, text: '' };

    incrementCount.run(code);

    const countRow = readCount.get(code) as
      | { totalCount: number }
      | undefined;

    if (!countRow) {
      throw new Error(
        `Message counter missing after increment for room ${code}`,
      );
    }

    const seq = countRow.totalCount;

    insertMessage.run(
      code,
      seq,
      JSON.stringify(safe),
    );

    const trimThrough = seq - MAX_MESSAGES_PER_ROOM;

    if (trimThrough > 0) {
      trimMessages.run(code, trimThrough);
    }

    return seq;
  });

  return tx();
}

/**
 * Return messages using the existing Agent Room absolute-cursor contract.
 *
 * fromIndex is the absolute number of messages the caller has already
 * consumed. It is not a retained-list index.
 *
 * If the caller has fallen behind far enough that older messages have
 * already been trimmed, return the oldest surviving message onward.
 */
export function listStoredMessages(
  code: string,
  fromIndex: number,
): Message[] {
  const db = getDb();

  const countRow = db.prepare(`
    SELECT totalCount
    FROM message_counts
    WHERE code = ?
  `).get(code) as { totalCount: number } | undefined;

  const retainedRow = db.prepare(`
    SELECT COUNT(*) AS retainedCount
    FROM messages
    WHERE code = ?
  `).get(code) as { retainedCount: number };

  const retainedCount = retainedRow.retainedCount;

  if (retainedCount === 0) {
    return [];
  }

  const totalCount = countRow?.totalCount ?? retainedCount;
  const trimmed = totalCount - retainedCount;

  let start = fromIndex - trimmed;

  if (start < 0) {
    start = 0;
  }

  if (start >= retainedCount) {
    return [];
  }

  const rows = db.prepare(`
    SELECT messageJson
    FROM messages
    WHERE code = ?
    ORDER BY seq ASC
    LIMIT -1 OFFSET ?
  `).all(code, start) as Array<{ messageJson: string }>;

  return rows.map(({ messageJson }) => {
    const message = JSON.parse(messageJson) as Message;

    // Match the Redis read-healing behavior for legacy/text-less messages.
    if (typeof message.text !== 'string') {
      message.text = '';
    }

    return message;
  });
}

/**
 * Absolute lifetime count. This value never decreases when retained
 * history is trimmed.
 */
export function getMessageCount(code: string): number {
  const db = getDb();

  const row = db.prepare(`
    SELECT totalCount
    FROM message_counts
    WHERE code = ?
  `).get(code) as { totalCount: number } | undefined;

  return row?.totalCount ?? 0;
}
