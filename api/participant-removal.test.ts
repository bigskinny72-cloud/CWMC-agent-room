import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, createSqlitePersistenceStores } from '@agent-room/sqlite-persistence';
import { removeParticipant } from '../apps/web/src/lib/roomApi';

let handler: any;
let temp: string;
let originalPath = process.env.AGENT_ROOM_SQLITE_PATH;
const keys = new Map<string, string>();
async function request(body: unknown) {
  let status = 200;
  let result: any;
  const res: any = { status(n: number) { status = n; return res; }, json(v: unknown) { result = v; return res; } };
  await handler({ method: 'POST', body }, res);
  return { status, result };
}
beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'agent-room-removal-'));
  process.env.AGENT_ROOM_SQLITE_PATH = join(temp, 'test.sqlite');
  openDb(process.env.AGENT_ROOM_SQLITE_PATH, 'create');
  handler = (await import('./room')).default;
  vi.stubGlobal('localStorage', { getItem: (key: string) => keys.get(key) ?? null });
  vi.stubGlobal('sessionStorage', { getItem: () => null });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('/api/room');
    const { status, result } = await request(JSON.parse(init.body as string));
    return { ok: status === 200, status, json: async () => result };
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  closeDb();
  if (originalPath === undefined) delete process.env.AGENT_ROOM_SQLITE_PATH;
  else process.env.AGENT_ROOM_SQLITE_PATH = originalPath;
  rmSync(temp, { recursive: true, force: true });
});
test('browser removal uses SQLite, preserves identity matching and existing guards', async () => {
  const code = 'REG-REM-001';
  const created = await request({ action: 'create', input: { code, topic: 'Removal regression', createdBy: 'Host' } });
  expect(created.status).toBe(200);
  keys.set(`room:${code}:hostKey`, created.result.hostKey);
  for (const client of ['cc', 'web']) {
    expect((await request({ action: 'join', code, participant: { name: 'Agent', client, role: 'member', canSpeak: true, joinedAt: 1, lastSeenAt: 1 } })).status).toBe(200);
  }
  // Join may disambiguate duplicate names. Seed the legacy same-name case
  // through the room-store contract in this disposable database only.
  await createSqlitePersistenceStores().rooms.casRoom(code, current => ({
    ...current,
    participants: current.participants.map(p => ({ ...p, name: 'Agent' })),
  }));
  const before = (await request({ action: 'get', code })).result.room;
  await expect(removeParticipant(code, 'Stranger', 'Agent', 'cc')).rejects.toMatchObject({ name: 'NotHostError' });
  expect((await request({ action: 'get', code })).result.room).toEqual(before);
  const removed = await removeParticipant(code, 'Host', 'Agent', 'cc');
  expect(removed.participants.some((p: any) => p.name === 'Agent' && p.client === 'cc')).toBe(false);
  expect(removed.participants.some((p: any) => p.name === 'Agent' && p.client === 'web')).toBe(true);
  expect(removed.version).toBe(before.version + 1);
  const { participants, version, ...rest } = removed;
  const { participants: oldParticipants, version: oldVersion, ...oldRest } = before;
  expect(rest).toEqual(oldRest);
  expect((await request({ action: 'get', code })).result.room).toEqual(removed);
  expect((await removeParticipant(code, 'Host', 'Absent', 'cc')).participants).toEqual(participants);
  expect((await removeParticipant(code, 'Agent', 'Agent', 'web')).participants.some((p: any) => p.name === 'Agent')).toBe(false);
  await expect(removeParticipant('NON-EXI-STS', 'Host', 'Agent', 'cc')).rejects.toMatchObject({ name: 'RoomNotFoundError' });
});
test('API rejects incomplete and invalid removal requests', async () => {
  for (const body of [{}, { code: 'REG-REM-001', requesterName: 'Host', targetName: 'Agent', targetClient: 'invalid' }]) {
    expect((await request({ action: 'remove-participant', ...body })).status).toBe(400);
  }
});
test('People control is wired to the local API wrapper', () => {
  const source = readFileSync(new URL('../apps/web/src/screens/Room.tsx', import.meta.url), 'utf8');
  expect(source).toContain("import { removeParticipant } from '../lib/roomApi.js'");
  expect(source).toContain('await removeParticipant(code, self.name, p.name, p.client)');
  expect(source).not.toContain('removeParticipant(client,');
});
