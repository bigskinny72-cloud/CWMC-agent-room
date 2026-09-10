import type { VercelRequest, VercelResponse } from '@vercel/node';
import { openDb, createSqlitePersistenceStores } from '@agent-room/sqlite-persistence';
import {
  createRoomWithStores,
  getRoomWithStores,
  removeParticipantWithStores,
  joinRoomWithStores,
  verifyHostClaimWithStores,
  setListenUntilWithStores,
  setMutedWithStores,
  endRoomWithStores,
  reactivateRoomWithStores,
  setReplyModeWithStores,
  getTurnStateWithStores,
  directInvokeWithStores,
  hostSkipCurrentWithStores,
  sweepTimeoutsWithStores,
  appendSystemMessageWithStores,
  createTaskWithStores,
  claimTaskWithStores,
  submitTaskWithStores,
  verifyTaskWithStores,
  reassignTaskRolesWithStores,
  buildRoomReport,
  registerRoomWebhookWithStores,
  listRoomWebhooksWithStores,
  unregisterRoomWebhookWithStores,
  NotParticipantError,
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
  listMessagesWithStores,
  readMessagesWithStores,
  appendMessageWithStores,
  getMessageTotalCountWithStores,
} from '@agent-room/upstash-client';
import type {
  Room,
  Participant,
  Message,
  ClientKind,
  ReplyModeConfig,
} from '@agent-room/shared';
import { generateCode } from '@agent-room/shared';

const sqlitePath = process.env.AGENT_ROOM_SQLITE_PATH;

if (!sqlitePath) {
  throw new Error('Missing AGENT_ROOM_SQLITE_PATH');
}

openDb(sqlitePath, 'open');
const stores = createSqlitePersistenceStores();

class InvalidRequest extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidRequest'; }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidRequest(`Missing or invalid ${field}`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidRequest(`Invalid ${field}`);
  return value;
}

function clientKind(value: unknown): ClientKind {
  if (value !== 'web' && value !== 'cc') throw new InvalidRequest('Invalid client kind');
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidRequest('Expected an object');
  return value as Record<string, unknown>;
}

function requireParticipant(room: Room, name: string, client?: ClientKind): void {
  if (!room.participants.some(p => p.name === name && (client === undefined || p.client === client))) {
    throw new NotParticipantError(name);
  }
}

async function requireHost(room: Room, name: string, hostKey: unknown): Promise<void> {
  if (name !== room.createdBy) throw new NotHostError(name, room.createdBy);
  try {
    await verifyHostClaimWithStores(stores, room.code, { hostKey: optionalString(hostKey, 'hostKey') });
  } catch {
    throw new NotHostError(name, room.createdBy);
  }
}

// Server report renderers share the same authority as the JSON API.
export async function getRoomReport(code: string) {
  return stores.reports.getReport(code);
}

async function systemNotice(code: string, text: string, metadata: Message['metadata']): Promise<void> {
  const now = Date.now();
  await appendSystemMessageWithStores(stores, code, {
    id: now, type: 'sys', name: 'system', client: 'cc', role: '',
    initials: 'AR', color: '#6B7280', time: now, text, metadata,
  });
}

function errorResponse(res: VercelResponse, error: unknown, defaultStatus = 500): void {
  if (error instanceof InvalidRequest) {
    res.status(400).json({ error: error.name, message: error.message });
  } else if (error instanceof NotParticipantError) {
    res.status(403).json({ error: error.name, message: error.message });
  } else if (error instanceof RoomNotFoundError) {
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

  try {
    const body = object(req.body);
    const action = requiredString(body.action, 'action');
    switch (action) {
      case 'create': {
        const raw = body.input === undefined ? body : object(body.input);
        const input = {
          ...(body.input === undefined ? {} : raw),
          code: raw.code === undefined ? generateCode() : requiredString(raw.code, 'code'),
          topic: requiredString(raw.topic, 'topic'),
          createdBy: requiredString(raw.createdBy, 'createdBy'),
        };
        const result = await createRoomWithStores(stores, input);
        res.status(200).json(result);
        return;
      }
      case 'get': {
        const code = body.code as string;
        if (!code) {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing code' });
          return;
        }
        const room = await getRoomWithStores(stores, code);
        res.status(200).json({ room });
        return;
      }

      case 'remove-participant': {
        const { code, requesterName, targetName, targetClient } = body;
        if (typeof code !== 'string' || !code ||
            typeof requesterName !== 'string' || !requesterName ||
            typeof targetName !== 'string' || !targetName ||
            (targetClient !== 'web' && targetClient !== 'cc')) {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing or invalid code, requesterName, targetName, or targetClient' });
          return;
        }
        const room = await removeParticipantWithStores(stores, code, requesterName, targetName, targetClient);
        res.status(200).json({ room });
        return;
      }

      case 'verify-host': {
        const code = body.code as string;
        const hostKey = body.hostKey as string | undefined;

        if (!code) {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing code' });
          return;
        }

        await verifyHostClaimWithStores(stores, code, { hostKey });
        res.status(200).json({});
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

        const result = await joinRoomWithStores(stores, code, participant, { hostKey, priorIdentity });
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

        const result = await readMessagesWithStores(stores, code, cursor);
        res.status(200).json(result);
        return;
      }

      case 'message-count': {
        const code = body.code as string;

        if (!code) {
          res.status(400).json({ error: 'InvalidRequest', message: 'Missing code' });
          return;
        }

        const total = await getMessageTotalCountWithStores(stores, code);
        res.status(200).json({ total });
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

        const result = await appendMessageWithStores(stores, code, message, kind);
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

        await setListenUntilWithStores(stores, code, name, until);
        res.status(200).json({});
        return;
      }

      case 'getReport': {
        res.status(200).json({ report: await getRoomReport(requiredString(body.code, 'code')) });
        return;
      }
      case 'setMuted':
      case 'end':
      case 'reactivate':
      case 'setReplyMode':
      case 'turnState':
      case 'directInvoke':
      case 'skipCurrent':
      case 'systemMessage':
      case 'sweep':
      case 'taskBoard':
      case 'taskCreate':
      case 'taskClaim':
      case 'taskSubmit':
      case 'taskVerify':
      case 'taskReassign':
      case 'createReport':
      case 'webhookSet':
      case 'webhookList':
      case 'webhookDelete': {
        const code = requiredString(body.code, 'code');
        const room = await getRoomWithStores(stores, code);
        if (action === 'turnState') {
          res.status(200).json({ turnState: await getTurnStateWithStores(stores, code) });
        } else if (action === 'taskBoard') {
          res.status(200).json({ board: await stores.taskBoards.getTaskBoard(code) ?? { code, tasks: [], version: 0 } });
        } else if (action === 'createReport') {
          const messages = await listMessagesWithStores(stores, code, 0);
          const board = await stores.taskBoards.getTaskBoard(code);
          const report = buildRoomReport(room, messages, board);
          await stores.reports.saveReport(code, report);
          res.status(200).json({ report });
        } else if (action === 'sweep') {
          const swept = await sweepTimeoutsWithStores(stores, code, room);
          for (const skipped of swept.skipped) {
            await systemNotice(code, `Skipped ${skipped.name}'s expired ${skipped.role} slot.`, {
              eventType: 'timed_out', targetAgentName: skipped.name, targetAgentClient: skipped.client,
            });
          }
          if (swept.handoff) {
            await systemNotice(code, `Moderator handed off to ${swept.handoff.toName}.`, { eventType: 'moderator_handoff' });
          } else if (swept.fallback) {
            await systemNotice(code, 'Reply mode fell back to open.', { eventType: 'moderator_fallback' });
          }
          res.status(200).json({ room: await getRoomWithStores(stores, code) });
        } else if (action === 'webhookList') {
          res.status(200).json({ webhooks: await listRoomWebhooksWithStores(stores, code) });
        } else if (action === 'webhookSet' || action === 'webhookDelete') {
          const name = requiredString(body.requesterName, 'requesterName');
          requireParticipant(room, name);
          if (action === 'webhookSet') {
            const url = requiredString(body.url, 'url');
            let parsed: URL;
            try { parsed = new URL(url); } catch { throw new InvalidRequest('Invalid webhook URL'); }
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new InvalidRequest('Invalid webhook protocol');
            const webhook = await registerRoomWebhookWithStores(stores, code, {
              url, registeredBy: name, secret: optionalString(body.secret, 'secret'),
            });
            res.status(200).json({ webhook });
          } else {
            res.status(200).json({ removed: await unregisterRoomWebhookWithStores(stores, code, requiredString(body.id, 'id')) });
          }
        } else if (action === 'taskCreate') {
          const name = requiredString(body.requesterName, 'requesterName');
          requireParticipant(room, name);
          res.status(200).json(await createTaskWithStores(stores, code, {
            title: requiredString(body.title, 'title'), createdBy: name,
            id: optionalString(body.id, 'id'), dod: optionalString(body.dod, 'dod'),
            owner: optionalString(body.owner, 'owner'), verifier: optionalString(body.verifier, 'verifier'),
            ownerClient: body.ownerClient === undefined ? undefined : clientKind(body.ownerClient),
            verifierClient: body.verifierClient === undefined ? undefined : clientKind(body.verifierClient),
          }));
        } else if (action === 'taskClaim' || action === 'taskSubmit' || action === 'taskVerify') {
          const actor = { name: requiredString(body.name, 'name'), client: clientKind(body.client) };
          requireParticipant(room, actor.name, actor.client);
          const id = requiredString(body.id, 'id');
          if (action === 'taskClaim') {
            res.status(200).json(await claimTaskWithStores(stores, code, id, actor));
          } else if (action === 'taskSubmit') {
            const evidence = object(body.evidence);
            if (typeof evidence.exitCode !== 'number' || !Number.isFinite(evidence.exitCode)) throw new InvalidRequest('Invalid exitCode');
            res.status(200).json(await submitTaskWithStores(stores, code, id, actor, {
              fileListing: requiredString(evidence.fileListing, 'fileListing'),
              fileExcerpt: requiredString(evidence.fileExcerpt, 'fileExcerpt'),
              runOutput: requiredString(evidence.runOutput, 'runOutput'), exitCode: evidence.exitCode,
            }));
          } else {
            if (body.verdict !== 'done' && body.verdict !== 'rejected') throw new InvalidRequest('Invalid verdict');
            res.status(200).json(await verifyTaskWithStores(stores, code, id, actor, body.verdict, optionalString(body.note, 'note')));
          }
        } else {
          const name = requiredString(body.requesterName, 'requesterName');
          const moderator = room.replyMode === 'moderator' && room.modeConfig?.moderatorAgentName === name;
          const lead = room.replyMode === 'sequential' && room.modeConfig?.leadAgentName === name;
          const delegated = name !== room.createdBy && ((action === 'directInvoke' && moderator) || (action === 'taskReassign' && (moderator || lead)));
          if (delegated) {
            const kind = action === 'taskReassign' ? clientKind(body.requesterClient) : 'cc';
            const configuredKind = moderator ? room.modeConfig?.moderatorAgentClient : room.modeConfig?.leadAgentClient;
            if (kind !== configuredKind) throw new NotHostError(name, room.createdBy);
            requireParticipant(room, name, kind);
          } else {
            await requireHost(room, name, body.hostKey);
          }
          if (action === 'end' || action === 'reactivate') {
            const updated = action === 'end' ? await endRoomWithStores(stores, code) : await reactivateRoomWithStores(stores, code);
            res.status(200).json({ room: updated });
          } else if (action === 'setMuted') {
            if (typeof body.muted !== 'boolean') throw new InvalidRequest('Invalid muted');
            res.status(200).json({ room: await setMutedWithStores(stores, code, name, requiredString(body.targetName, 'targetName'), clientKind(body.targetClient), body.muted) });
          } else if (action === 'setReplyMode') {
            if (!['open', 'sequential', 'moderator'].includes(String(body.mode))) throw new InvalidRequest('Invalid mode');
            const config = body.config === undefined ? undefined : object(body.config);
            if (config) {
              for (const key of ['leadAgentName', 'moderatorAgentName']) optionalString(config[key], key);
              for (const key of ['leadAgentClient', 'moderatorAgentClient']) if (config[key] !== undefined) clientKind(config[key]);
              if (config.timeoutMs !== undefined && Object.values(object(config.timeoutMs)).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new InvalidRequest('Invalid timeoutMs');
            }
            res.status(200).json({ room: await setReplyModeWithStores(stores, code, name, body.mode as 'open' | 'sequential' | 'moderator', config as ReplyModeConfig | undefined) });
          } else if (action === 'directInvoke') {
            const rawTarget = object(body.target);
            const target = { name: requiredString(rawTarget.name, 'target.name'), client: clientKind(rawTarget.client) };
            requireParticipant(room, target.name, target.client);
            const added = await directInvokeWithStores(stores, code, target, delegated ? 'moderator' : 'host');
            if (added && delegated) await systemNotice(code, `${name} assigned ${target.name}.`, { eventType: 'moderator_dispatched', targetAgentName: target.name, targetAgentClient: target.client });
            res.status(200).json({ added });
          } else if (action === 'skipCurrent') {
            res.status(200).json({ skipped: await hostSkipCurrentWithStores(stores, code, room) });
          } else if (action === 'systemMessage') {
            const message = object(body.message);
            requiredString(message.text, 'message.text');
            if (message.type !== 'sys' || message.name !== 'system' || message.client !== 'cc' || typeof message.id !== 'number' || typeof message.time !== 'number') throw new InvalidRequest('Invalid system message');
            await appendSystemMessageWithStores(stores, code, message as unknown as Message);
            res.status(200).json({});
          } else if (action === 'taskReassign') {
            res.status(200).json(await reassignTaskRolesWithStores(stores, code, requiredString(body.id, 'id'), {
              owner: optionalString(body.owner, 'owner'), verifier: optionalString(body.verifier, 'verifier'),
              ownerClient: body.ownerClient === undefined ? undefined : clientKind(body.ownerClient),
              verifierClient: body.verifierClient === undefined ? undefined : clientKind(body.verifierClient),
            }, { name, client: clientKind(body.requesterClient) }));
          }
        }
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

