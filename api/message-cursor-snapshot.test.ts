import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_MESSAGES_PER_ROOM, type Message } from '@agent-room/shared';
import {
  appendStoredMessage,
  closeDb,
  openDb,
  readStoredMessages,
} from '@agent-room/sqlite-persistence';

let tempDir: string;

function message(id: number): Message {
  return {
    id,
    time: id,
    name: 'Agent',
    client: 'cc',
    text: `message-${id}`,
    type: 'msg',
    role: '',
    initials: 'AR',
    color: '#000000',
  };
}
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-room-b3a-'));
  openDb(join(tempDir, 'test.sqlite'), 'create');
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

test('trimmed history returns the authoritative absolute cursor', () => {
  const code = 'B3A-CURSOR-1';
  const total = MAX_MESSAGES_PER_ROOM + 7;
  for (let id = 1; id <= total; id += 1) {
    appendStoredMessage(code, message(id));
  }

  const first = readStoredMessages(code, 0);
  expect(first.messages).toHaveLength(MAX_MESSAGES_PER_ROOM);
  expect(first.messages[0]?.id).toBe(8);
  expect(first.messages.at(-1)?.id).toBe(total);
  expect(first.cursor).toBe(total);

  appendStoredMessage(code, message(total + 1));
  const next = readStoredMessages(code, first.cursor);
  expect(next.messages.map(m => m.id)).toEqual([total + 1]);
  expect(next.cursor).toBe(total + 1);
});
test('empty read still returns the current absolute cursor', () => {
  const code = 'B3A-CURSOR-2';
  appendStoredMessage(code, message(1));
  appendStoredMessage(code, message(2));

  const read = readStoredMessages(code, 2);
  expect(read.messages).toEqual([]);
  expect(read.cursor).toBe(2);
});
