import { PRESENCE_DISCONNECTED_MS, PRESENCE_STALE_MS, WEBHOOK_FAIL_DROP } from './constants.js';
import type { ClientKind, Message, Participant, ParticipantHealth, Room, RoomWebhook } from './types.js';

export function extractMentionNames(text: string): string[] {
  const found: string[] = [];
  const re = /(^|[^\w])@([^\s@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[2]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

export function isSenderParticipant(p: Participant, message: Pick<Message, 'name' | 'client'>): boolean {
  return p.name === message.name && p.client === message.client;
}

export function webhookMatchesParticipant(hook: RoomWebhook, participant: Participant): boolean {
  if (hook.identityKey) {
    return Boolean(participant.identityKey && hook.identityKey === participant.identityKey);
  }
  return hook.registeredBy === participant.name;
}

export function resolveWakeRecipients(room: Room, message: Message): {
  mode: 'direct' | 'broadcast';
  recipients: Participant[];
} {
  const unique = (list: Participant[]) => {
    const seen = new Set<string>();
    return list.filter((p) => {
      const id = p.identityKey ?? `${p.name}:${p.client}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };

  if (message.metadata?.targetIdentityKey) {
    return {
      mode: 'direct',
      recipients: unique(room.participants.filter((p) => p.identityKey === message.metadata?.targetIdentityKey)),
    };
  }

  if (message.metadata?.targetAgentName) {
    const client = message.metadata.targetAgentClient;
    return {
      mode: 'direct',
      recipients: unique(room.participants.filter((p) =>
        p.name === message.metadata?.targetAgentName
        && (client ? p.client === client : true)
      )),
    };
  }

  const mentions = extractMentionNames(message.text ?? '');
  if (mentions.length > 0) {
    return {
      mode: 'direct',
      recipients: unique(room.participants.filter((p) => mentions.includes(p.name))),
    };
  }

  return {
    mode: 'broadcast',
    recipients: unique(room.participants.filter((p) => !isSenderParticipant(p, message))),
  };
}

export function webhookIsUsable(hook: RoomWebhook): boolean {
  return (hook.failCount ?? 0) < WEBHOOK_FAIL_DROP;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (host === '127.0.0.1' || host.startsWith('127.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (host.startsWith('169.254.')) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

function envAllowsHttpWebhooks(): boolean {
  return typeof process !== 'undefined' && process.env?.AGENT_ROOM_WEBHOOK_ALLOW_HTTP === '1';
}

/** Same URL policy used by wake dispatch. */
export function webhookUrlAllowed(url: string, allowHttp = envAllowsHttpWebhooks()): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) return false;
  if (!allowHttp && isPrivateHostname(parsed.hostname)) return false;
  return true;
}

export function webhookTransportReady(
  hook: RoomWebhook,
  allowHttp = envAllowsHttpWebhooks(),
): boolean {
  return webhookIsUsable(hook) && webhookUrlAllowed(hook.url, allowHttp);
}

export function participantHealth(
  participant: Participant,
  hooks: RoomWebhook[],
  now: number,
  options?: { allowHttp?: boolean },
): ParticipantHealth {
  const allowHttp = options?.allowHttp ?? envAllowsHttpWebhooks();
  const listening = Boolean(participant.listenUntil && participant.listenUntil > now);
  const recentlySeen = now - participant.lastSeenAt <= PRESENCE_STALE_MS;
  const connected = listening || recentlySeen;
  const reachable = hooks.some((hook) =>
    webhookTransportReady(hook, allowHttp) && webhookMatchesParticipant(hook, participant),
  );
  const wakeable = reachable || listening;
  const disconnected = !connected && !reachable;
  return {
    name: participant.name,
    client: participant.client,
    ...(participant.identityKey ? { identityKey: participant.identityKey } : {}),
    member: true,
    connected,
    listening,
    reachable,
    wakeable,
    disconnected,
    processing: false,
  };
}

export function presenceLabel(health: ParticipantHealth): {
  kind: 'listening' | 'connected' | 'reachable' | 'disconnected';
  label: string;
  detail: string;
} {
  if (health.listening) {
    return { kind: 'listening', label: 'Listening', detail: 'Active listen window' };
  }
  if (health.connected) {
    return { kind: 'connected', label: 'Connected', detail: 'Recent presence signal' };
  }
  if (health.reachable || health.wakeable) {
    return { kind: 'reachable', label: 'Reachable', detail: 'Wake transport registered' };
  }
  return { kind: 'disconnected', label: 'Disconnected', detail: health.member ? 'Roster only — no connection or wake transport' : '' };
}

export function isStaleDisconnected(lastSeenAt: number, now: number): boolean {
  return now - lastSeenAt > PRESENCE_DISCONNECTED_MS;
}

export type { ClientKind };
