import type { ClientKind, Participant, Room } from '@agent-room/shared';

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

export async function joinRoom(
  code: string,
  participant: Participant,
  options?: {
    priorIdentity?: { name: string; client: ClientKind };
  },
): Promise<void> {
  await roomApi<unknown>({
    action: 'join',
    code,
    participant,
    priorIdentity: options?.priorIdentity,
  });
}
