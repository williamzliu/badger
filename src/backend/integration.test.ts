import assert from 'node:assert/strict';
import { CartesiaClient } from '../voice/cartesia.js';
import { SpectrumMessagingClient, type SpectrumTransportFactory } from '../voice/spectrum.js';
import { LiveCommunications, type Communications } from './communications.js';
import { openDatabase } from './db.js';
import { EventLog } from './events.js';
import { createServer } from './server.js';
import { SessionStore } from './sessions.js';
import { BadgerWorkflow } from './state-machine.js';

const calls = { start: 0, stop: 0, prewarm: 0, contact: 0, preferences: 0, confirmation: 0, webhook: 0 };
const communications: Communications = {
  async start() { calls.start += 1; },
  async stop() { calls.stop += 1; },
  async prewarm() { calls.prewarm += 1; },
  async contact() { calls.contact += 1; },
  async afterPreferences() { calls.preferences += 1; },
  async afterConfirmation() { calls.confirmation += 1; },
  async handleCartesiaWebhook(secret) {
    calls.webhook += 1;
    assert.equal(secret, 'secret');
    return { duplicate: false, events: [] };
  },
};

const { app } = createServer(':memory:', { communications });
const created = await app.inject({ method: 'POST', url: '/sessions', payload: { hostName: 'Host', goal: 'Demo' } });
const session = created.json();
assert.equal(calls.prewarm, 1);
const added = await app.inject({ method: 'POST', url: `/sessions/${session.id}/participants`, payload: { name: 'Alex', phone: '+15550000123' } });
const participant = added.json();
await app.inject({ method: 'POST', url: `/sessions/${session.id}/start` });
assert.equal(calls.start, 1);
assert.equal(calls.contact, 1);

const preferences = await app.inject({
  method: 'POST',
  url: '/internal/preferences',
  payload: {
    sessionId: session.id,
    participantId: participant.id,
    availability: ['friday_after_8'],
    hardVetoes: [],
    preferences: ['imax'],
    flexibility: 0.5,
    summary: 'Friday works',
  },
});
assert.equal(preferences.statusCode, 200);
assert.equal(calls.preferences, 1);

const duplicatePreferences = await app.inject({
  method: 'POST',
  url: '/internal/preferences',
  payload: {
    sessionId: session.id,
    participantId: participant.id,
    availability: ['friday_after_8'],
    hardVetoes: [],
    preferences: ['imax'],
    flexibility: 0.5,
    summary: 'Friday works',
  },
});
assert.equal(duplicatePreferences.statusCode, 200);
assert.equal(calls.preferences, 1);

const confirmation = await app.inject({ method: 'POST', url: `/sessions/${session.id}/participants/${participant.id}/confirm` });
assert.equal(confirmation.json().status, 'COMMITTED');
assert.equal(calls.confirmation, 1);

const latePreferences = await app.inject({
  method: 'POST',
  url: '/internal/preferences',
  payload: {
    sessionId: session.id,
    participantId: participant.id,
    availability: [],
    hardVetoes: ['all_times'],
    preferences: ['no_call'],
    flexibility: 0,
    summary: 'Late result from a completed call',
  },
});
assert.equal(latePreferences.statusCode, 200);
assert.equal(latePreferences.json().status, 'COMMITTED');
assert.equal(calls.preferences, 1);

const unavailableCreated = await app.inject({
  method: 'POST',
  url: '/sessions',
  payload: { hostName: 'Host', goal: 'Unavailable participant test' },
});
const unavailableSession = unavailableCreated.json();
const unavailableAdded = await app.inject({
  method: 'POST',
  url: `/sessions/${unavailableSession.id}/participants`,
  payload: { name: 'Taylor', phone: '+15550000999' },
});
const unavailableParticipant = unavailableAdded.json();
await app.inject({ method: 'POST', url: `/sessions/${unavailableSession.id}/start` });
const unavailablePreferences = await app.inject({
  method: 'POST',
  url: '/internal/preferences',
  payload: {
    sessionId: unavailableSession.id,
    participantId: unavailableParticipant.id,
    availability: [],
    hardVetoes: ['all_times'],
    preferences: ['no_call'],
    flexibility: 0,
    summary: 'Unavailable at every proposed time',
  },
});
assert.equal(unavailablePreferences.statusCode, 200);
assert.equal(unavailablePreferences.json().status, 'CANCELLED');
assert.equal(unavailablePreferences.json().participants[0].status, 'DECLINED');

const webhook = await app.inject({
  method: 'POST',
  url: '/webhooks/cartesia',
  headers: { 'x-webhook-secret': 'secret' },
  payload: { type: 'call_started' },
});
assert.equal(webhook.statusCode, 200);
assert.equal(calls.webhook, 1);
await app.close();
assert.equal(calls.stop, 1);
const liveDb = openDatabase(':memory:');
const liveStore = new SessionStore(liveDb);
const sharedEvents = new EventLog(liveDb);
const liveWorkflow = new BadgerWorkflow(liveStore, sharedEvents);
const draft = liveStore.create({ hostName: 'Host', goal: 'hang' });
liveStore.addParticipant(draft, { name: 'Alex', phone: '+15550000456' });
const proposing = liveStore.get(draft.id)!;
liveWorkflow.start(proposing);
const liveSentBodies: string[] = [];
const inboundFactory: SpectrumTransportFactory = async () => ({
  async sendText(_to, body) {
    liveSentBodies.push(body);
    return { messageId: 'sent', status: 'sent', service: 'iMessage' };
  },
  async *inbound() {
    yield { messageId: 'reply-ambiguous-no', from: '+15550000456', body: "can't make it", timestamp: new Date().toISOString(), service: 'iMessage' };
    yield { messageId: 'reply-prefs', from: '+15550000456', body: 'all day', timestamp: new Date().toISOString(), service: 'iMessage' };
    yield { messageId: 'reply-counter', from: '+15550000456', body: 'no can we do thursday?', timestamp: new Date().toISOString(), service: 'iMessage' };
    yield { messageId: 'reply-confirm', from: '+15550000456', body: 'Thursday works', timestamp: new Date().toISOString(), service: 'iMessage' };
  },
  async stop() {},
});
const live = new LiveCommunications({
  sessions: liveStore,
  events: sharedEvents,
  workflow: liveWorkflow,
  cartesia: new CartesiaClient({
    apiKey: 'key', agentId: 'agent', fromNumberId: 'number',
    fetch: async () => new Response(JSON.stringify({ calls: [] }), { status: 200 }),
  }),
  spectrum: new SpectrumMessagingClient({ projectId: 'project', projectSecret: 'secret' }, inboundFactory),
  cartesiaWebhookSecret: 'webhook',
  planner: {
    async recommend(current) {
      return {
        action: current.status === 'COMMITTED' ? 'COMMIT_PLAN' : 'PROPOSE_PLAN',
        candidateId: current.selectedCandidateId!,
        participantId: null,
        message: 'Badger coordination message',
        reason: 'Validated test action',
        channel: 'SMS',
        delaySeconds: 0,
      };
    },
    async recordOutcome() {},
  },
});
await live.start();
for (let attempt = 0; attempt < 20 && liveStore.get(draft.id)?.status !== 'COMMITTED'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
assert.equal(liveStore.get(draft.id)?.status, 'COMMITTED');
assert.match(
  liveStore.get(draft.id)?.candidates.find((candidate) => candidate.id === liveStore.get(draft.id)?.selectedCandidateId)?.time ?? '',
  /^Thursday /,
);
assert.equal(sharedEvents.list(draft.id).some((event) => event.type === 'proposal.rejected'), true);
assert.equal(sharedEvents.list(draft.id).some((event) => event.type === 'session.cancelled'), false);
assert.equal(liveSentBodies.some((body) => body.includes('another day and time')), true);
await live.stop();

const orchestrationDb = openDatabase(':memory:');
const orchestrationStore = new SessionStore(orchestrationDb);
const orchestrationEvents = new EventLog(orchestrationDb);
const orchestrationWorkflow = new BadgerWorkflow(orchestrationStore, orchestrationEvents);
const orchestrationDraft = orchestrationStore.create({ hostName: 'Host', goal: 'go karting this week' });
const orchestrationParticipant = orchestrationStore.addParticipant(orchestrationDraft, { name: 'Solo', phone: '+15550000777' });
const orchestrationSession = orchestrationStore.get(orchestrationDraft.id)!;
orchestrationWorkflow.start(orchestrationSession);
const sentBodies: string[] = [];
const orchestrationTransport: SpectrumTransportFactory = async () => ({
  async sendText(_to, body) {
    sentBodies.push(body);
    return { messageId: 'planned-message', status: 'sent', service: 'iMessage' };
  },
  async *inbound() {},
  async stop() {},
});
const orchestrated = new LiveCommunications({
  sessions: orchestrationStore,
  events: orchestrationEvents,
  workflow: orchestrationWorkflow,
  cartesia: new CartesiaClient({
    apiKey: 'key', agentId: 'agent', fromNumberId: 'number',
    fetch: async () => new Response(JSON.stringify({ calls: [{ agent_call_id: 'planned-call', number: '+15550000777' }] }), { status: 200 }),
  }),
  spectrum: new SpectrumMessagingClient({ projectId: 'project', projectSecret: 'secret' }, orchestrationTransport),
  cartesiaWebhookSecret: 'webhook',
  planner: {
    async prepare() {
      return {
        candidates: [
          { id: 'researched-one', theater: 'K1 Speed', time: 'Thursday 7 PM', slot: 'thursday_evening', format: 'Go-karting', price: 35, location: 'South San Francisco' },
          { id: 'researched-two', theater: 'K1 Speed', time: 'Friday 7 PM', slot: 'friday_evening', format: 'Go-karting', price: 35, location: 'South San Francisco' },
        ],
        research: [
          { id: 'researched-one', theater: 'K1 Speed', time: 'Thursday 7 PM', slot: 'thursday_evening', format: 'Go-karting', price: 35, location: 'South San Francisco', sourceUrl: 'https://example.com/thursday', evidence: 'Open Thursday' },
          { id: 'researched-two', theater: 'K1 Speed', time: 'Friday 7 PM', slot: 'friday_evening', format: 'Go-karting', price: 35, location: 'South San Francisco', sourceUrl: 'https://example.com/friday', evidence: 'Open Friday' },
        ],
        outreach: [{ participantId: orchestrationParticipant.id, channel: 'CALL_ONLY' as const, delaySeconds: 0, callAfterSeconds: 0, message: 'Ask for broad availability.', reason: 'Call the host first' }],
        insights: ['Evidence · Two karting windows are sourced.', 'Plan · Call first; text only if the call fails.'],
        reason: 'Research before outreach',
      };
    },
    async recommend() { throw new Error('not needed'); },
    async recordOutcome() {},
  },
});
await orchestrated.start();
await orchestrated.contact(orchestrationSession);
for (let attempt = 0; attempt < 20 && !orchestrationEvents.list(orchestrationSession.id).some((event) => event.type === 'call.requested'); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
assert.equal(orchestrationStore.get(orchestrationSession.id)?.candidates[0]?.theater, 'K1 Speed');
assert.equal(sentBodies.length, 0);
assert.equal(orchestrationEvents.list(orchestrationSession.id).some((event) => event.type === 'research.completed'), true);
assert.equal(orchestrationEvents.list(orchestrationSession.id).some((event) => event.type === 'call.requested'), true);
await orchestrated.stop();

const liveEnv = {
  BADGER_LIVE_MODE: 'true',
  BADGER_TOOL_SECRET: 'tool',
  CARTESIA_API_KEY: 'cartesia',
  CARTESIA_AGENT_ID: 'agent',
  CARTESIA_FROM_NUMBER_ID: 'number',
  CARTESIA_WEBHOOK_SECRET: 'webhook',
  SPECTRUM_PROJECT_ID: 'spectrum',
  SPECTRUM_PROJECT_SECRET: 'secret',
};
const previousEnv = Object.fromEntries(Object.keys(liveEnv).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(liveEnv)) process.env[key] = value;
const previousSailKey = process.env.SAIL_API_KEY;
delete process.env.SAIL_API_KEY;
assert.throws(() => createServer(':memory:'), /SAIL_API_KEY is required/);
for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
if (previousSailKey === undefined) delete process.env.SAIL_API_KEY;
else process.env.SAIL_API_KEY = previousSailKey;
console.info('integration wiring test passed');
