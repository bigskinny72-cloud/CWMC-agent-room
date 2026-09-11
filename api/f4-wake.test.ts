import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, createSqlitePersistenceStores } from '@agent-room/sqlite-persistence';
import type { ClientKind, Participant } from '@agent-room/shared';

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

function participant(name: string, extra: Partial<Participant> = {}): Participant {
  return {
    name, client: 'cc' as ClientKind, role: 'member', color: '#000000', initials: 'AR',
    canSpeak: true, joinedAt: 1, lastSeenAt: 1, ...extra,
  };
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'agent-room-f4-'));
  process.env.AGENT_ROOM_SQLITE_PATH = join(temp, 'test.sqlite');
  openDb(process.env.AGENT_ROOM_SQLITE_PATH, 'create');
  handler = (await import('./room')).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  closeDb();
  if (originalPath === undefined) delete process.env.AGENT_ROOM_SQLITE_PATH;
  else process.env.AGENT_ROOM_SQLITE_PATH = originalPath;
  rmSync(temp, { recursive: true, force: true });
});

test('API send wakes only the targeted identityKey and leaves polling recoverable', async () => {
  const created = await request({ action: 'create', code: 'F4-WAKE-001', topic: 'F4', createdBy: 'Host' });
  const hostKey = created.result.hostKey as string;
  await request({ action: 'join', code: 'F4-WAKE-001', participant: participant('Host', { client: 'web' }), hostKey });
  await request({ action: 'join', code: 'F4-WAKE-001', participant: participant('Grandpa', { identityKey: 'alpha' }) });
  await request({ action: 'join', code: 'F4-WAKE-001', participant: participant('Grandpa', { identityKey: 'beta' }) });
  await request({
    action: 'webhookSet', code: 'F4-WAKE-001', requesterName: 'Grandpa', identityKey: 'alpha',
    url: 'https://wake.example/alpha', secret: 's-a',
  });
  const grandpa2 = (await stores.rooms.getRoom('F4-WAKE-001')).participants.find(p => p.identityKey === 'beta')!;
  await request({
    action: 'webhookSet', code: 'F4-WAKE-001', requesterName: grandpa2.name, identityKey: 'beta',
    url: 'https://wake.example/beta', secret: 's-b',
  });

  const posted: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    posted.push(String(url));
    expect(init?.method).toBe('POST');
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });

  const sent = await request({
    action: 'send',
    code: 'F4-WAKE-001',
    hostKey,
    message: {
      id: 2, type: 'msg', name: 'Host', client: 'web', role: '', initials: 'HO', color: '#000',
      text: '@Grandpa look', time: 2,
    },
  });
  expect(sent.status).toBe(200);
  expect(posted).toEqual(['https://wake.example/alpha']);
  const listed = await request({ action: 'messages', code: 'F4-WAKE-001', cursor: 0 });
  expect(listed.result.messages.some((m: { text: string }) => m.text === '@Grandpa look')).toBe(true);
});

test('failed wake dispatch still leaves the message recoverable for polling', async () => {
  const created = await request({ action: 'create', code: 'F4-POLL-001', topic: 'F4', createdBy: 'Host' });
  const hostKey = created.result.hostKey as string;
  await request({ action: 'join', code: 'F4-POLL-001', participant: participant('Host', { client: 'web' }), hostKey });
  await request({ action: 'join', code: 'F4-POLL-001', participant: participant('Grandpa', { identityKey: 'alpha' }) });
  await request({
    action: 'webhookSet', code: 'F4-POLL-001', requesterName: 'Grandpa', identityKey: 'alpha',
    url: 'https://wake.example/alpha',
  });
  vi.stubGlobal('fetch', async () => {
    throw new Error('transport down');
  });
  const sent = await request({
    action: 'send',
    code: 'F4-POLL-001',
    hostKey,
    message: {
      id: 2, type: 'msg', name: 'Host', client: 'web', role: '', initials: 'HO', color: '#000',
      text: '@Grandpa recover-me', time: 2,
    },
  });
  expect(sent.status).toBe(200);
  const listed = await request({ action: 'messages', code: 'F4-POLL-001', cursor: 0 });
  expect(listed.result.messages.some((m: { text: string }) => m.text === '@Grandpa recover-me')).toBe(true);
});

test('GET presence distinguishes roster, listening, reachable, and never claims processing', async () => {
  const created = await request({ action: 'create', code: 'F4-HEALTH-001', topic: 'F4', createdBy: 'Host' });
  const hostKey = created.result.hostKey as string;
  await request({ action: 'join', code: 'F4-HEALTH-001', participant: participant('Host', { client: 'web' }), hostKey });
  await request({ action: 'join', code: 'F4-HEALTH-001', participant: participant('Idle', { identityKey: 'idle', lastSeenAt: 1 }) });
  await request({ action: 'join', code: 'F4-HEALTH-001', participant: participant('Ear', { identityKey: 'ear' }) });
  await request({ action: 'presence', code: 'F4-HEALTH-001', name: 'Ear', until: Date.now() + 60_000 });
  await request({
    action: 'webhookSet', code: 'F4-HEALTH-001', requesterName: 'Idle', identityKey: 'idle',
    url: 'https://wake.example/idle',
  });
  const got = await request({ action: 'get', code: 'F4-HEALTH-001' });
  expect(JSON.stringify(got.result)).not.toContain('https://wake.example/idle');
  const idle = got.result.presence.find((h: { identityKey?: string }) => h.identityKey === 'idle');
  const ear = got.result.presence.find((h: { identityKey?: string }) => h.identityKey === 'ear');
  expect(idle.reachable).toBe(true);
  expect(idle.processing).toBe(false);
  expect(ear.listening).toBe(true);
  expect(ear.processing).toBe(false);
});

test('GET presence is not reachable for a registered webhook dispatch would refuse', async () => {
  const created = await request({ action: 'create', code: 'F4-HEALTH-002', topic: 'F4', createdBy: 'Host' });
  const hostKey = created.result.hostKey as string;
  await request({ action: 'join', code: 'F4-HEALTH-002', participant: participant('Host', { client: 'web' }), hostKey });
  await request({ action: 'join', code: 'F4-HEALTH-002', participant: participant('Idle', { identityKey: 'idle', lastSeenAt: 1 }) });
  await request({
    action: 'webhookSet', code: 'F4-HEALTH-002', requesterName: 'Idle', identityKey: 'idle',
    url: 'http://127.0.0.1:9/wake',
  });
  const got = await request({ action: 'get', code: 'F4-HEALTH-002' });
  expect(JSON.stringify(got.result.presence)).not.toContain('127.0.0.1');
  const idle = got.result.presence.find((h: { identityKey?: string }) => h.identityKey === 'idle');
  expect(idle.reachable).toBe(false);
  expect(idle.wakeable).toBe(false);
  expect(idle.processing).toBe(false);
});
