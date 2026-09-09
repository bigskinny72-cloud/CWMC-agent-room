export interface CreateRoomInput {
  code: string;
  topic: string;
  createdBy: string;
}

export interface CreateRoomResult {
  code: string;
  hostKey: string;
}

export async function createRoom(input: CreateRoomInput): Promise<CreateRoomResult> {
  const response = await fetch('/api/room', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'create',
      input,
    }),
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(body?.message ?? `Room API failed with HTTP ${response.status}`);
  }

  return body as CreateRoomResult;
}
