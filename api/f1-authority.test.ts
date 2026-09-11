import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, createSqlitePersistenceStores } from '@agent-room/sqlite-persistence';
import type { ClientKind, Participant } from '@agent-room/shared';
import type { AgentRoomState } from '../apps/mcp/src/state';

let handler: typeof import('./room').default;
let temp: string;
const originalPath = process.env.AGENT_ROOM_SQLITE_PATH;
const stores = createSqlitePersistenceStores();

async function request(body: Record<string, unknown>) {
  let status = 200;
  let result: any;
  const res: any = { status(n: number) { status = n; return res; }, json(v: unknown) { result = v; return res; } };
  await handler({ method: 'POST', body } as any, res);
  return { status, result };
}

function participant(name: string, client: ClientKind = 'cc'): Participant {
  return { name, client, role: 'member', color: '#000000', initials: 'AR', canSpeak: true, joinedAt: 1, lastSeenAt: 1 };
}

async function create(code: string) {
  const { status, result } = await request({ action: 'create', code, topic: 'F1 authority', createdBy: 'Host' });
  expect(status).toBe(200);
  expect(result).not.toHaveProperty('hostKeyHash');
  expect(result.hostKey).toMatch(/^[a-f0-9]{32}$/);
  for (const name of ['Host', 'Agent', 'Reviewer']) {
    expect((await request({ action: 'join', code, participant: participant(name), hostKey: name === 'Host' ? result.hostKey : undefined })).status).toBe(200);
  }
  return { code, hostKey: result.hostKey as string, requesterName: 'Host' };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  temp = mkdtempSync(join(tmpdir(), 'agent-room-f1-'));
  process.env.AGENT_ROOM_SQLITE_PATH = join(temp, 'test.sqlite');
  openDb(process.env.AGENT_ROOM_SQLITE_PATH, 'create');
  handler = (await import('./room')).default;
});

afterAll(() => {
  closeDb();
  if (originalPath === undefined) delete process.env.AGENT_ROOM_SQLITE_PATH;
  else process.env.AGENT_ROOM_SQLITE_PATH = originalPath;
  vi.useRealTimers();
  rmSync(temp, { recursive: true, force: true });
});

test('public, member and host responses omit the hash; only create returns the host key', async () => {
  const host = await create('F1-VIEW-001');
  const storedHash = (await stores.rooms.getRoom(host.code)).hostKeyHash;
  expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
  const bodies = [
    { action: 'get', code: host.code },
    { action: 'get', ...host },
    { action: 'join', code: host.code, participant: participant('New member') },
    { action: 'join', ...host, participant: participant('Host') },
    { action: 'remove-participant', code: host.code, requesterName: 'New member', targetName: 'New member', targetClient: 'cc' },
    { action: 'remove-participant', ...host, targetName: 'Reviewer', targetClient: 'cc' },
    { action: 'sweep', code: host.code },
    { action: 'setMuted', ...host, targetName: 'Agent', targetClient: 'cc', muted: true },
    { action: 'setReplyMode', ...host, mode: 'open' },
    { action: 'end', ...host },
    { action: 'reactivate', ...host },
  ];
  for (const body of bodies) {
    const response = await request(body);
    expect(response.status, body.action).toBe(200);
    const view = response.result.room ?? response.result;
    expect(view.code).toBe(host.code);
    expect(view).not.toHaveProperty('hostKeyHash');
    expect(view).not.toHaveProperty('hostKey');
    expect(JSON.stringify(response.result)).not.toContain(storedHash);
    expect(JSON.stringify(response.result)).not.toContain(host.hostKey);
    expect((await stores.rooms.getRoom(host.code)).hostKeyHash).toBe(storedHash);
  }
  expect((await request({ action: 'verify-host', ...host })).status).toBe(200);
});

test('cross-agent removal needs host proof; exact self and stale-self cleanup stay keyless', async () => {
  const host = await create('F1-LEAVE-001');
  const before = await stores.rooms.getRoom(host.code);
  for (const proof of [{ requesterName: 'Host' }, { requesterName: 'Host', hostKey: 'wrong' }, { requesterName: 'Agent', hostKey: host.hostKey }]) {
    expect((await request({ action: 'remove-participant', code: host.code, targetName: 'Reviewer', targetClient: 'cc', ...proof })).status).toBe(403);
    expect(await stores.rooms.getRoom(host.code)).toEqual(before);
  }
  // Legacy same-name client tuples: removal must not broaden to both rows.
  await stores.rooms.casRoom(host.code, room => ({ ...room, participants: [...room.participants, participant('Agent', 'web')] }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const removed = await request({ action: 'remove-participant', code: host.code, requesterName: 'Agent', targetName: 'Agent', targetClient: 'cc' });
    expect(removed.status).toBe(200);
    expect(removed.result.room.participants).toContainEqual(participant('Agent', 'web'));
    expect(removed.result.room.participants.some((p: Participant) => p.name === 'Agent' && p.client === 'cc')).toBe(false);
  }
  expect((await request({ action: 'remove-participant', ...host, targetName: 'Reviewer', targetClient: 'cc' })).status).toBe(200);
  expect((await request({ action: 'remove-participant', code: host.code, requesterName: 'Host', targetName: 'Host', targetClient: 'cc' })).status).toBe(200);
  expect((await request({ action: 'sweep', code: host.code })).status).toBe(200);
});

test('host join and prior-host replacement require proof, while member reconnect preserves host mute', async () => {
  const host = await create('F1-JOIN-001');
  const before = await stores.rooms.getRoom(host.code);
  for (const name of ['Host', ' host ', 'HOST']) {
    for (const hostKey of [undefined, 'wrong']) {
      expect((await request({ action: 'join', code: host.code, participant: participant(name), hostKey })).status).toBe(409);
      expect(await stores.rooms.getRoom(host.code)).toEqual(before);
    }
  }
  expect((await request({ action: 'join', code: host.code, participant: participant('Intruder'), priorIdentity: { name: ' host ', client: 'cc' } })).status).toBe(409);
  expect(await stores.rooms.getRoom(host.code)).toEqual(before);
  const joined = await request({ action: 'join', ...host, participant: participant(' host ') });
  expect(joined.status).toBe(200);
  expect(joined.result.participant.name).toBe('Host');
  expect((await request({ action: 'setMuted', ...host, targetName: 'Agent', targetClient: 'cc', muted: true })).status).toBe(200);
  const rejoined = await request({ action: 'join', code: host.code, participant: participant('Agent'), priorIdentity: { name: 'Agent', client: 'cc' } });
  expect(rejoined.status).toBe(200);
  expect(rejoined.result.participant.canSpeak).toBe(false);
});

test('host messages and privileged controls reject missing/wrong proof without mutations', async () => {
  const host = await create('F1-HOST-001');
  const message = { id: 1, time: 1, name: 'Host', client: 'cc', text: 'Host instruction', type: 'msg', role: '', initials: 'AR', color: '#000000' };
  const actions = [
    { action: 'send', message },
    { action: 'setMuted', targetName: 'Agent', targetClient: 'cc', muted: true },
    { action: 'end' }, { action: 'reactivate' },
    { action: 'setReplyMode', mode: 'open' },
    { action: 'directInvoke', target: { name: 'Agent', client: 'cc' } },
    { action: 'skipCurrent' },
    { action: 'taskReassign', id: 'absent', requesterClient: 'cc', owner: 'Reviewer' },
    { action: 'systemMessage', message: { ...message, name: 'system', type: 'sys' } },
  ];
  const before = await stores.rooms.getRoom(host.code);
  for (const action of actions) {
    for (const hostKey of [undefined, 'wrong']) {
      expect((await request({ ...host, ...action, hostKey })).status, action.action).toBe(403);
      expect(await stores.rooms.getRoom(host.code)).toEqual(before);
      expect(await stores.messages.getMessageTotalCount(host.code)).toBeNull();
      expect(await stores.turnState.getTurnState(host.code)).toBeNull();
      expect(await stores.taskBoards.getTaskBoard(host.code)).toBeNull();
    }
  }
  expect((await request({ action: 'send', ...host, message })).status).toBe(200);
  expect((await request({ action: 'send', code: host.code, message: { ...message, name: 'Agent' } })).status).toBe(200);
  expect((await request({ action: 'send', code: host.code, message: { ...message, name: 'Agent', type: 'sys' } })).status).toBe(400);
  expect(await stores.messages.getMessageTotalCount(host.code)).toBe(2);
});

test('webhook secrets stay in storage; only owner or proven host can update/delete a registration', async () => {
  const host = await create('F1-HOOK-001');
  const payload = { action: 'webhookSet', code: host.code, requesterName: 'Agent', url: 'https://receiver.invalid/hook', secret: 'f1-secret' };
  const created = await request(payload);
  expect(created.status).toBe(200);
  expect(created.result.webhook).not.toHaveProperty('secret');
  const id = created.result.webhook.id;
  const before = await stores.webhooks.listWebhooks(host.code);
  expect(before[0].secret).toBe('f1-secret');
  for (const proof of [{ requesterName: 'Reviewer' }, { requesterName: 'Host' }, { requesterName: 'Host', hostKey: 'wrong' }, { requesterName: 'Absent', hostKey: host.hostKey }]) {
    expect((await request({ ...payload, ...proof, secret: 'stolen' })).status).toBe(403);
    for (const identifier of [id, payload.url]) {
      expect((await request({ action: 'webhookDelete', code: host.code, id: identifier, ...proof })).status).toBe(403);
    }
    expect(await stores.webhooks.listWebhooks(host.code)).toEqual(before);
  }
  for (const proof of [{}, { requesterName: 'Agent' }, host]) {
    const listed = await request({ action: 'webhookList', code: host.code, ...proof });
    expect(listed.status).toBe(200);
    expect(listed.result.webhooks).toEqual([created.result.webhook]);
    expect(JSON.stringify(listed.result)).not.toContain('f1-secret');
  }
  const updated = await request({ ...payload, secret: 'replacement' });
  expect(updated.status).toBe(200);
  expect(updated.result.webhook.id).toBe(id);
  expect(updated.result.webhook).not.toHaveProperty('secret');
  expect((await stores.webhooks.listWebhooks(host.code))[0].secret).toBe('replacement');
  expect((await request({ action: 'webhookDelete', code: host.code, requesterName: 'Agent', id })).result.removed).toBe(true);
  expect((await request(payload)).status).toBe(200);
  expect((await request({ action: 'webhookDelete', ...host, id: payload.url })).result.removed).toBe(true);
  expect((await request(payload)).status).toBe(200);
  const hostUpdate = await request({ ...payload, ...host, secret: 'host-replacement' });
  expect(hostUpdate.status).toBe(200);
  expect(hostUpdate.result.webhook).not.toHaveProperty('secret');
  expect((await stores.webhooks.listWebhooks(host.code))[0]).toMatchObject({ registeredBy: 'Host', secret: 'host-replacement' });
});

test('MCP host rejoin retains the capability for the greeting and a subsequent host action', async () => {
  const host = await create('F1-MCP-001');
  await request({ action: 'remove-participant', code: host.code, requesterName: 'Host', targetName: 'Host', targetClient: 'cc' });
  const state = await import('../apps/mcp/src/state');
  const memory: AgentRoomState = { version: 1, blockStreak: 0, rooms: {
    [host.code]: { name: 'Host', cursor: 0, joinedAt: 1, hostKey: host.hostKey },
  } };
  vi.spyOn(state, 'readRoomStateForJoin').mockImplementation(async code => memory.rooms[code]);
  vi.spyOn(state, 'readState').mockResolvedValue(memory);
  vi.spyOn(state, 'setRoom').mockImplementation(async (code, room) => { memory.rooms[code] = room; });
  vi.spyOn(state, 'removeRoom').mockImplementation(async code => { delete memory.rooms[code]; });
  vi.stubEnv('CLAUDECODE', '1');
  vi.stubEnv('AGENT_ROOM_BASE_URL', 'http://agent-room.test');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('http://agent-room.test/api/room');
    const response = await request(JSON.parse(init.body as string));
    return { ok: response.status === 200, status: response.status, json: async () => response.result };
  });
  try {
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const { registerTools } = await import('../apps/mcp/src/tools');
    let call: any;
    registerTools({ setRequestHandler(schema: unknown, callback: unknown) {
      if (schema === CallToolRequestSchema) call = callback;
    } } as any);
    const joined = await call({ params: { name: 'room_join', arguments: { code: host.code, name: 'Host', listenAfterJoin: false } } });
    expect(JSON.parse(joined.content[0].text).assignedName).toBe('Host');
    expect(memory.rooms[host.code]?.hostKey).toBe(host.hostKey);
    expect(await stores.messages.getMessageTotalCount(host.code)).toBe(1);
    const ended = await call({ params: { name: 'room_end', arguments: { code: host.code } } });
    expect(JSON.parse(ended.content[0].text).ended).toBe(true);
    expect((await stores.rooms.getRoom(host.code)).status).toBe('ended');
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
