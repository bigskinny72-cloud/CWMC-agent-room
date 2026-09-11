import { describe, expect, it } from 'vitest';
import { participantHealth, presenceLabel, resolveWakeRecipients } from '../src/health.js';
import { WEBHOOK_FAIL_DROP } from '../src/constants.js';
import type { Message, Participant, Room, RoomWebhook } from '../src/types.js';

const now = 1_000_000;

function p(name: string, extra: Partial<Participant> = {}): Participant {
  return {
    name, role: '', color: '#000', initials: name.slice(0, 2).toUpperCase(),
    client: 'cc', joinedAt: 0, lastSeenAt: 0, ...extra,
  };
}

function room(participants: Participant[]): Room {
  return {
    code: 'AAA-BBB-CCC', topic: 't', createdAt: 0, createdBy: 'Host',
    status: 'active', version: 1, participants,
  };
}

function msg(text: string, extra: Partial<Message> = {}): Message {
  return {
    id: 1, type: 'msg', name: 'Host', initials: 'HO', color: '#111',
    role: '', text, client: 'web', time: 1, ...extra,
  };
}

describe('resolveWakeRecipients', () => {
  const alpha = p('Grandpa', { identityKey: 'alpha' });
  const beta = p('Grandpa (2)', { identityKey: 'beta' });
  const host = p('Host', { client: 'web' });
  const r = room([host, alpha, beta]);

  it('targets identityKey A and never Grandpa (2)/beta', () => {
    const result = resolveWakeRecipients(r, msg('ping', {
      metadata: { targetIdentityKey: 'alpha' },
    }));
    expect(result.mode).toBe('direct');
    expect(result.recipients.map(x => x.identityKey)).toEqual(['alpha']);
  });

  it('uses exact @Grandpa display match, not Grandpa (2)', () => {
    const result = resolveWakeRecipients(r, msg('@Grandpa please look'));
    expect(result.mode).toBe('direct');
    expect(result.recipients.map(x => x.identityKey)).toEqual(['alpha']);
  });

  it('broadcasts to everyone except the sender', () => {
    const result = resolveWakeRecipients(r, msg('hello all', { name: 'Host', client: 'web' }));
    expect(result.mode).toBe('broadcast');
    expect(result.recipients.map(x => x.identityKey).sort()).toEqual(['alpha', 'beta']);
  });
});

describe('participantHealth', () => {
  const hook: RoomWebhook = {
    id: 'wh_1', url: 'https://wake.example/a', registeredBy: 'Grandpa',
    identityKey: 'alpha', createdAt: 0,
  };

  it('treats roster-only as disconnected, not reachable or processing', () => {
    const health = participantHealth(p('Grandpa', { identityKey: 'alpha', lastSeenAt: 0 }), [], now);
    expect(health.member).toBe(true);
    expect(health.connected).toBe(false);
    expect(health.listening).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.wakeable).toBe(false);
    expect(health.disconnected).toBe(true);
    expect(health.processing).toBe(false);
    expect(presenceLabel(health).kind).toBe('disconnected');
  });

  it('reports listening when listenUntil is in the future', () => {
    const health = participantHealth(p('Grandpa', {
      identityKey: 'alpha', lastSeenAt: now, listenUntil: now + 10_000,
    }), [], now);
    expect(health.listening).toBe(true);
    expect(health.connected).toBe(true);
    expect(health.disconnected).toBe(false);
    expect(presenceLabel(health).kind).toBe('listening');
  });

  it('reports reachable/wakeable for a healthy registered wake transport', () => {
    const health = participantHealth(p('Grandpa', { identityKey: 'alpha', lastSeenAt: 0 }), [hook], now);
    expect(health.reachable).toBe(true);
    expect(health.wakeable).toBe(true);
    expect(health.disconnected).toBe(false);
    expect(health.processing).toBe(false);
    expect(presenceLabel(health).kind).toBe('reachable');
  });

  it('treats expired/stale registration as unreachable', () => {
    const stale: RoomWebhook = { ...hook, failCount: WEBHOOK_FAIL_DROP };
    const health = participantHealth(p('Grandpa', { identityKey: 'alpha', lastSeenAt: 0 }), [stale], now);
    expect(health.reachable).toBe(false);
    expect(health.wakeable).toBe(false);
    expect(health.disconnected).toBe(true);
  });

  it('does not report reachable for a matched webhook the dispatcher would refuse', () => {
    const disallowed: RoomWebhook = { ...hook, url: 'http://127.0.0.1:9/wake' };
    const grandpa = p('Grandpa', { identityKey: 'alpha', lastSeenAt: 0 });
    const blocked = participantHealth(grandpa, [disallowed], now, { allowHttp: false });
    expect(blocked.reachable).toBe(false);
    expect(blocked.wakeable).toBe(false);
    expect(JSON.stringify(blocked)).not.toContain('http://127.0.0.1');
  });

  it('reports reachable when the same webhook is allowed by dispatch policy', () => {
    const httpHook: RoomWebhook = { ...hook, url: 'http://wake.example/a' };
    const grandpa = p('Grandpa', { identityKey: 'alpha', lastSeenAt: 0 });
    expect(participantHealth(grandpa, [httpHook], now, { allowHttp: false }).reachable).toBe(false);
    const allowed = participantHealth(grandpa, [httpHook], now, { allowHttp: true });
    expect(allowed.reachable).toBe(true);
    expect(allowed.wakeable).toBe(true);
    expect(JSON.stringify(allowed)).not.toContain('http://wake.example/a');
  });
});
