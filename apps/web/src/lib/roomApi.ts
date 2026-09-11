import type { ClientKind, Message, Participant, Room, RoomReport, ReplyMode, ReplyModeConfig, TurnState, TurnSpokenEntry } from '@agent-room/shared';
export type { TurnState } from '@agent-room/shared';

export interface CreateRoomInput {
  code: string;
  topic: string;
  createdBy: string;
}

export interface CreateRoomResult {
  code: string;
  hostKey: string;
}

async function roomApi<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/room', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (!response.ok) {
    const error = new Error(result?.message ?? `Room API failed with HTTP ${response.status}`);
    error.name = result?.error ?? 'RoomApiError';
    throw error;
  }

  return result as T;
}

export async function createRoom(input: CreateRoomInput): Promise<CreateRoomResult> {
  return roomApi<CreateRoomResult>({
    action: 'create',
    input,
  });
}

export async function getRoom(code: string): Promise<Room> {
  const result = await roomApi<{ room: Room }>({
    action: 'get',
    code,
  });

  return result.room;
}

export async function verifyHostKey(
  code: string,
  hostKey: string | undefined,
): Promise<void> {
  await roomApi<Record<string, never>>({
    action: 'verify-host',
    code,
    hostKey,
  });
}

export interface JoinRoomResult {
  participant: Participant;
}

export async function joinRoom(
  code: string,
  participant: Participant,
  options?: {
    priorIdentity?: { name: string; client: ClientKind };
  },
): Promise<JoinRoomResult> {
  return hostRequest<JoinRoomResult>(code, participant.name, {
    action: 'join',
    code,
    participant,
    priorIdentity: options?.priorIdentity,
  });
}
export async function readMessages(code: string, cursor: number): Promise<{ messages: Message[]; cursor: number }> {
  return roomApi<{ messages: Message[]; cursor: number }>({ action: 'messages', code, cursor });
}

export async function listMessages(code: string, cursor: number): Promise<Message[]> {
  return (await readMessages(code, cursor)).messages;
}

export async function getMessageTotalCount(code: string): Promise<number | null> {
  const result = await roomApi<{ total: number | null }>({
    action: 'message-count',
    code,
  });

  return result.total;
}

export async function appendMessage(
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<void> {
  await hostRequest<unknown>(code, message.name, {
    action: 'send',
    code,
    message,
    kind,
  });
}

export async function updatePresence(
  code: string,
  name: string,
  until: number,
): Promise<void> {
  await roomApi<unknown>({
    action: 'presence',
    code,
    name,
    until,
  });
}

export async function removeParticipant(
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc',
): Promise<Room> {
  const payload = { action: 'remove-participant', code, requesterName, targetName, targetClient };
  const result = await (requesterName === targetName
    ? roomApi<{ room: Room }>(payload)
    : hostRequest<{ room: Room }>(code, requesterName, payload));
  return result.room;
}

function hostRequest<T>(code: string, requesterName: string, payload: Record<string, unknown>): Promise<T> {
  const hostKey = localStorage.getItem(`room:${code}:hostKey`)
    ?? sessionStorage.getItem(`room:${code}:hostKey`) ?? undefined;
  return roomApi<T>({ ...payload, code, requesterName, hostKey });
}

export async function setMuted(code: string, requesterName: string, targetName: string, targetClient: ClientKind, muted: boolean): Promise<Room> {
  return (await hostRequest<{ room: Room }>(code, requesterName, { action: 'setMuted', targetName, targetClient, muted })).room;
}

export async function endRoom(code: string, requesterName: string): Promise<Room> {
  return (await hostRequest<{ room: Room }>(code, requesterName, { action: 'end' })).room;
}

export async function reactivateRoom(code: string, requesterName: string): Promise<Room> {
  return (await hostRequest<{ room: Room }>(code, requesterName, { action: 'reactivate' })).room;
}

export async function setReplyMode(code: string, requesterName: string, mode: ReplyMode, config: ReplyModeConfig | undefined): Promise<Room> {
  return (await hostRequest<{ room: Room }>(code, requesterName, { action: 'setReplyMode', mode, config })).room;
}

export async function getTurnState(code: string): Promise<TurnState | null> {
  return (await roomApi<{ turnState: TurnState | null }>({ action: 'turnState', code })).turnState;
}

export async function directInvoke(code: string, requesterName: string, target: { name: string; client: ClientKind }, source: 'host' | 'moderator'): Promise<boolean> {
  return (await hostRequest<{ added: boolean }>(code, requesterName, { action: 'directInvoke', target, source })).added;
}

export async function hostSkipCurrent(code: string, requesterName: string): Promise<TurnSpokenEntry | null> {
  return (await hostRequest<{ skipped: TurnSpokenEntry | null }>(code, requesterName, { action: 'skipCurrent' })).skipped;
}

export async function appendSystemMessage(code: string, requesterName: string, message: Message): Promise<void> {
  await hostRequest(code, requesterName, { action: 'systemMessage', message });
}

export async function createRoomReport(code: string): Promise<RoomReport> {
  return (await roomApi<{ report: RoomReport }>({ action: 'createReport', code })).report;
}

export async function getRoomReport(code: string): Promise<RoomReport | null> {
  return (await roomApi<{ report: RoomReport | null }>({ action: 'getReport', code })).report;
}
