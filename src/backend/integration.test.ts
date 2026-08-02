import assert from 'node:assert/strict';
import { CartesiaClient } from '../voice/cartesia.js';
import { SpectrumMessagingClient, type SpectrumTransportFactory } from '../voice/spectrum.js';
import { LiveCommunications, type Communications } from './communications.js';
import { openDatabase } from './db.js';
import { EventLog } from './events.js';
import { createServer } from './server.js';
import { SessionStore } from './sessions.js';
import { BadgerWorkflow } from './state-machine.js';

const calls = { start: 0, stop: 0, contact: 0, preferences: 0, confirmation: 0, webhook: 0 };
const communications: Communications = {
  async start() { calls.start += 1; },
  async stop() { calls.stop += 1; },
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

const confirmation = await app.inject({ method: 'POST', url: `/sessions/${session.id}/participants/${participant.id}/confirm` });
assert.equal(confirmation.json().status, 'COMMITTED');
assert.equal(calls.confirmation, 1);

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
const draft = liveStore.create({ hostName: 'Host', goal: 'Movie' });
liveStore.addParticipant(draft, { name: 'Alex', phone: '+15550000456' });
const proposing = liveStore.get(draft.id)!;
liveWorkflow.start(proposing);
liveWorkflow.recordPreferences(proposing, proposing.participants[0]!, {
  availability: ['friday_after_8'], hardVetoes: [], preferences: ['imax'], flexibility: 0.5, summary: 'Friday',
});
const inboundFactory: SpectrumTransportFactory = async () => ({
  async sendText() { return { messageId: 'sent', status: 'sent', service: 'iMessage' }; },
  async *inbound() {
    yield { messageId: 'reply', from: '+15550000456', body: 'YES', timestamp: new Date().toISOString(), service: 'iMessage' };
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
});
await live.start();
for (let attempt = 0; attempt < 20 && liveStore.get(draft.id)?.status !== 'COMMITTED'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
assert.equal(liveStore.get(draft.id)?.status, 'COMMITTED');
await live.stop();
console.info('integration wiring test passed');
