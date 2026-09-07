import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@agent-room/upstash-client';
import {
  getRoom,
  joinRoom,
  setListenUntil,
  RoomNotFoundError,
  HostNameTakenError,
  InterviewRoomBusyError,
  MutedError,
  NotYourTurnError,
  NotHostError,
  InvalidModeConfigError,
  ModeNotSupportedError,
} from '@agent-room/upstash-client';
import {
  listMessages,
  appendMessage,
} from '@agent-room/upstash-client';
import type {
  Room,
  Participant,
  Message,
  ClientKind,
} from '@agent-room/shared';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
}

const client = createClient({ url, token });

function errorResponse(res: VercelResponse, error: unknown, defaultStatus = 500): void {
  if (error instanceof RoomNotFoundError) {
    res.status(404).json({ error: 'RoomNotFoundError', message: error.message });
  } else if (error instanceof HostNameTakenError) {
    res.status(409).json({ error: 'HostNameTakenError', message: error.message });
  } else if (error instanceof InterviewRoomBusyError) {
    res.status(409).json({ error: 'InterviewRoomBusyError', message: error.message });
  } else if (error instanceof MutedError) {
    res.status(403).json({ error: 'MutedError', message: error.message });
  } else if (error instanceof NotYourTurnError) {
    res.status(403).json({ error: 'NotYourTurnError', message: error.message });
  } else if (error instanceof NotHostError) {
    res.status(403).json({ error: 'NotHostError', message: error.message });
  } else if (error instanceof InvalidModeConfigError) {
    res.status(400).json({ error: 'InvalidModeConfigError', message: error.message });
  } else if (error instanceof ModeNotSupportedError) {
    res.status(400).json({ error: 'ModeNotSupportedError', message: error.message });
  } else if (error instanceof Error) {
    res.status(defaultStatus).json({
      error: error.name,
      message: error.message,
      cause: error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message }
        : String(error.cause ?? ''),
    });
  } else {
    res.status(defaultStatus).json({ error: 'UnknownError', message: String(error) });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).setHeader('Allow', 'POST').end();
    return;
  }

  const body = req.body as Record<string, unknown>;
  const action = body.action as string;

  try {
    switch (action) {
      case 'get': {
        const code = body.code as string;
        if (!code) {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing code' });
          return;
        }
        const room = await getRoom(client, code);
        res.status(200).json({ room });
        return;
      }

      case 'join': {
        const code = body.code as string;
        const participant = body.participant as Participant;
        const hostKey = body.hostKey as string | undefined;
        const priorIdentity = body.priorIdentity as { name: string; client: ClientKind } | undefined;

        if (!code || !participant) {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing code or participant' });
          return;
        }

        const result = await joinRoom(client, code, participant, { hostKey, priorIdentity });
        res.status(200).json(result);
        return;
      }

      case 'messages': {
        const code = body.code as string;
        const cursor = body.cursor as number;

        if (!code || typeof cursor !== 'number') {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing code or cursor' });
          return;
        }

        const messages = await listMessages(client, code, cursor);
        res.status(200).json({ messages });
        return;
      }

      case 'send': {
        const code = body.code as string;
        const message = body.message as Message;
        const kind = (body.kind as 'message' | 'status') ?? 'message';

        if (!code || !message) {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing code or message' });
          return;
        }

        const result = await appendMessage(client, code, message, kind);
        res.status(200).json({ result });
        return;
      }

      case 'presence': {
        const code = body.code as string;
        const name = body.name as string;
        const until = body.until as number;

        if (!code || !name || typeof until !== 'number') {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing code, name, or until' });
          return;
        }

        await setListenUntil(client, code, name, until);
        res.status(200).json({});
        return;
      }

      default:
        res.status(400).json({
          error: 'InvalidAction',
          message: `Unknown action: ${action}`,
        });
        return;
    }
  } catch (e) {
    errorResponse(res, e);
  }
}