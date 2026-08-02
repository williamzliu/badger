import Fastify from 'fastify';
import { openDatabase } from './db.js';
import { EventLog } from './events.js';
import { SessionStore } from './sessions.js';
import { BadgerWorkflow } from './state-machine.js';
import { AddParticipantInput, CreateSessionInput } from '../shared/types.js';

function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

export function createServer(databasePath = ':memory:') {
  const database = openDatabase(databasePath);
  const sessions = new SessionStore(database);
  const events = new EventLog(database);
  const workflow = new BadgerWorkflow(sessions, events);
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ ok: true }));
  app.post('/sessions', async (request, reply) => {
    const input = request.body as CreateSessionInput;
    if (!validText(input?.hostName) || !validText(input?.goal)) return reply.code(400).send({ error: 'hostName and goal are required' });
    const session = sessions.create(input);
    events.append(session.id, 'session.created', 'Badger created');
    return reply.code(201).send(session);
  });
  app.get('/sessions/:id', async (request, reply) => {
    const session = sessions.get((request.params as { id: string }).id);
    return session ?? reply.code(404).send({ error: 'Session not found' });
  });
  app.post('/sessions/:id/participants', async (request, reply) => {
    const session = sessions.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const input = request.body as AddParticipantInput;
    if (!validText(input?.name) || !validText(input?.phone)) return reply.code(400).send({ error: 'name and phone are required' });
    const participant = sessions.addParticipant(session, input);
    events.append(session.id, 'participant.added', `${participant.name} added`, { participantId: participant.id });
    return reply.code(201).send(participant);
  });
  app.post('/sessions/:id/start', async (request, reply) => {
    const session = sessions.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    try { return workflow.start(session); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.get('/sessions/:id/events', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!sessions.get(id)) return reply.code(404).send({ error: 'Session not found' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    events.list(id).forEach((event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    const unsubscribe = events.subscribe(id, (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    request.raw.on('close', unsubscribe);
  });
  return { app, sessions, events, workflow };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app } = createServer(process.env.DATABASE_PATH ?? './data/badger.db');
  app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
