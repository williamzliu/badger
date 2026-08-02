import Fastify, { type FastifyReply } from 'fastify';
import type { AddParticipantInput, CreateSessionInput, Preferences, SessionStatus } from '../shared/types.js';
import { type Communications, createConfiguredCommunications } from './communications.js';
import { openDatabase } from './db.js';
import { EventLog, toPublicEvent } from './events.js';
import { SessionStore } from './sessions.js';
import { BadgerWorkflow } from './state-machine.js';

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validPreferences(value: unknown): value is Preferences {
  const preferences = value as Preferences;
  return Boolean(
    preferences &&
    Array.isArray(preferences.availability) &&
    Array.isArray(preferences.hardVetoes) &&
    Array.isArray(preferences.preferences) &&
    Number.isFinite(preferences.flexibility) &&
    preferences.flexibility >= 0 &&
    preferences.flexibility <= 1 &&
    validText(preferences.summary),
  );
}

type ServerOptions = { communications?: Communications | null };

export function createServer(databasePath = ':memory:', options: ServerOptions = {}) {
  const database = openDatabase(databasePath);
  const sessions = new SessionStore(database);
  const events = new EventLog(database);
  const workflow = new BadgerWorkflow(sessions, events);
  const communications = options.communications === undefined
    ? createConfiguredCommunications({ sessions, events, workflow })
    : options.communications ?? undefined;
  const app = Fastify({ logger: false });

  app.addHook('onReady', async () => communications?.start());
  app.addHook('onClose', async () => communications?.stop());

  app.get('/health', async () => ({ ok: true, live: Boolean(communications) }));

  app.post('/sessions', async (request, reply) => {
    const input = request.body as CreateSessionInput;
    if (!validText(input?.hostName) || !validText(input?.goal)) {
      return reply.code(400).send({ error: 'hostName and goal are required' });
    }
    const session = sessions.create(input);
    events.append(session.id, 'session.created', 'Badger created');
    return reply.code(201).send(session);
  });

  app.get('/sessions/:id', async (request, reply) =>
    sessions.get((request.params as { id: string }).id) ?? reply.code(404).send({ error: 'Session not found' }));

  app.post('/sessions/:id/participants', async (request, reply) => {
    const session = sessions.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const input = request.body as AddParticipantInput;
    if (!validText(input?.name) || !validText(input?.phone)) {
      return reply.code(400).send({ error: 'name and phone are required' });
    }
    try {
      const participant = sessions.addParticipant(session, input);
      events.append(session.id, 'participant.added', `${participant.name} added`, { participantId: participant.id });
      return reply.code(201).send(participant);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.post('/sessions/:id/start', async (request, reply) => {
    const session = sessions.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    try {
      workflow.start(session);
      const fresh = sessions.get(session.id)!;
      await communications?.contact(fresh);
      return sessions.get(session.id);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  // Operator escape hatch: stop an in-flight session so no further calls or
  // texts go out (pending call timers re-check status and stand down).
  app.post('/sessions/:id/cancel', async (request, reply) => {
    const session = sessions.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.status === 'COMMITTED') return reply.code(400).send({ error: 'Session is already committed' });
    if (session.status !== 'CANCELLED') {
      session.status = 'CANCELLED';
      sessions.updateSession(session);
      events.append(session.id, 'session.cancelled', 'The host called it off');
    }
    return sessions.get(session.id);
  });

  async function receivePreferences(
    body: { sessionId?: string; participantId?: string } & Preferences,
    reply: FastifyReply,
  ) {
    const session = body.sessionId ? sessions.get(body.sessionId) : undefined;
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const participant = session.participants.find((item) => item.id === body.participantId);
    if (!participant) return reply.code(404).send({ error: 'Participant not found' });
    if (!validPreferences(body)) return reply.code(400).send({ error: 'Invalid preferences payload' });
    const submitted = {
      availability: body.availability,
      hardVetoes: body.hardVetoes,
      preferences: body.preferences,
      flexibility: body.flexibility,
      summary: body.summary,
    };
    if (participant.preferences) {
      const current = {
        availability: participant.preferences.availability,
        hardVetoes: participant.preferences.hardVetoes,
        preferences: participant.preferences.preferences,
        flexibility: participant.preferences.flexibility,
        summary: participant.preferences.summary,
      };
      if (JSON.stringify(current) === JSON.stringify(submitted)) return session;
    }
    try {
      const previousStatus = session.status;
      workflow.recordPreferences(session, participant, body);
      const fresh = sessions.get(session.id)!;
      await communications?.afterPreferences(fresh, previousStatus);
      return sessions.get(session.id);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  }

  app.post('/internal/preferences', async (request, reply) => {
    const expected = process.env.BADGER_TOOL_SECRET;
    if (expected && request.headers.authorization !== `Bearer ${expected}`) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    return receivePreferences(request.body as { sessionId?: string; participantId?: string } & Preferences, reply);
  });

  app.post('/internal/demo/inject', async (request, reply) => {
    if (process.env.BADGER_DEMO_MODE !== 'true' || communications) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return receivePreferences(request.body as { sessionId?: string; participantId?: string } & Preferences, reply);
  });

  for (const action of ['confirm', 'decline'] as const) {
    app.post(`/sessions/:id/participants/:participantId/${action}`, async (request, reply) => {
      const params = request.params as { id: string; participantId: string };
      const session = sessions.get(params.id);
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      const participant = session.participants.find((item) => item.id === params.participantId);
      if (!participant) return reply.code(404).send({ error: 'Participant not found' });
      try {
        const previousStatus: SessionStatus = session.status;
        if (action === 'confirm') workflow.confirm(session, participant);
        else workflow.decline(session, participant);
        const fresh = sessions.get(session.id)!;
        if (action === 'confirm') await communications?.afterConfirmation(fresh, previousStatus);
        return sessions.get(session.id);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    });
  }

  app.post('/webhooks/cartesia', async (request, reply) => {
    if (!communications) return reply.code(503).send({ error: 'Live communications are disabled' });
    const header = request.headers['x-webhook-secret'];
    const secret = Array.isArray(header) ? header[0] : header;
    try {
      const result = await communications.handleCartesiaWebhook(secret, request.body);
      return { ok: true, duplicate: result.duplicate, events: result.events.length };
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message === 'Invalid Cartesia webhook secret' ? 401 : 400).send({ error: message });
    }
  });

  app.get('/sessions/:id/events', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!sessions.get(id)) return reply.code(404).send({ error: 'Session not found' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    events.list(id).forEach((event) => reply.raw.write(`data: ${JSON.stringify(toPublicEvent(event))}\n\n`));
    const unsubscribe = events.subscribe(id, (event) =>
      reply.raw.write(`data: ${JSON.stringify(toPublicEvent(event))}\n\n`));
    request.raw.on('close', unsubscribe);
  });

  return { app, sessions, events, workflow, communications };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { app } = createServer(process.env.DATABASE_PATH ?? './data/badger.db');
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  console.info(`Badger backend listening on http://localhost:${port}`);
}
