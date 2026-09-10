import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDb,
  openDb,
  createSqlitePersistenceStores,
} from '@agent-room/sqlite-persistence';
import {
  appendMessageWithStores,
  createRoomWithStores,
} from '@agent-room/upstash-client';
import type {
  ClientKind,
  Message,
  Participant,
  TurnState,
} from '@agent-room/shared';
import type { PersistenceStores } from '@agent-room/persistence';

let tempDir: string;
let dbPath: string;

function participant(
  name: string,
  client: ClientKind,
  joinedAt: number,
): Participant {
  return {
    name,
    client,
    role: 'member',
    color: '#000000',
    initials: name.slice(0, 2).toUpperCase(),
    canSpeak: true,
    joinedAt,
    lastSeenAt: joinedAt,
  };
}

function msg(
  name: string,
  client: ClientKind,
  text: string,
  id: number,
): Message {
  return {
    id,
    time: id,
    name,
    client,
    text,
    type: 'msg',
    role: 'member',
    initials: name.slice(0, 2).toUpperCase(),
    color: '#000000',
  };
}

async function setupSequentialLeadTurn(
  stores: PersistenceStores,
  code: string,
): Promise<TurnState> {
  await createRoomWithStores(stores, {
    code,
    topic: 'B2a atomicity',
    createdBy: 'Host',
  });

  await stores.rooms.casRoom(code, (room) => ({
    ...room,
    version: room.version + 1,
    replyMode: 'sequential',
    modeConfig: {
      leadAgentName: 'Agent',
      leadAgentClient: 'cc',
    },
    participants: [
      participant('Host', 'web', 1),
      participant('Agent', 'cc', 2),
      participant('Reviewer', 'cc', 3),
    ],
  }));

  const now = Date.now();
  const turn: TurnState = {
    turnId: 1,
    mode: 'sequential',
    leadName: 'Agent',
    leadClient: 'cc',
    currentName: 'Agent',
    currentClient: 'cc',
    currentRole: 'lead',
    deadline: now + 60_000,
    hardDeadline: now + 300_000,
    queue: [{ name: 'Reviewer', client: 'cc', role: 'supplement' }],
    spoken: [],
  };
  await stores.turnState.setTurnState(code, turn);
  return turn;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-room-b2a-'));
  dbPath = join(tempDir, 'test.sqlite');
  openDb(dbPath, 'create');
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

test('appendMessageWithStores rolls back turn state when message insert fails', async () => {
  const stores = createSqlitePersistenceStores();
  const code = 'B2A-ROL-001';
  const before = await setupSequentialLeadTurn(stores, code);

  const failingStores: PersistenceStores = {
    ...stores,
    messages: {
      ...stores.messages,
      appendMessage: async () => {
        throw new Error('forced message append failure');
      },
    },
  };

  await expect(
    appendMessageWithStores(
      failingStores,
      code,
      msg('Agent', 'cc', 'should not persist', 1001),
    ),
  ).rejects.toThrow('forced message append failure');

  expect(await stores.turnState.getTurnState(code)).toEqual(before);
  expect(await stores.messages.listMessages(code, 0)).toEqual([]);
  expect(await stores.messages.getMessageTotalCount(code)).toBeNull();
});

test('appendMessageWithStores commits turn advance and message together', async () => {
  const stores = createSqlitePersistenceStores();
  const code = 'B2A-OK-0001';
  await setupSequentialLeadTurn(stores, code);

  const result = await appendMessageWithStores(
    stores,
    code,
    msg('Agent', 'cc', 'lead reply commits atomically', 2002),
  );

  expect(result.appended).toBe(true);
  expect(result.metadata.roleAtSend).toBe('lead');
  expect(result.metadata.modeAtSend).toBe('sequential');

  const after = await stores.turnState.getTurnState(code);
  expect(after?.currentName).toBe('Reviewer');
  expect(after?.spoken).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'Agent',
        client: 'cc',
        role: 'lead',
        status: 'replied',
      }),
    ]),
  );

  const messages = await stores.messages.listMessages(code, 0);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toBe('lead reply commits atomically');
  expect(messages[0]?.metadata?.turnId).toBe(1);
  expect(await stores.messages.getMessageTotalCount(code)).toBe(1);
});
