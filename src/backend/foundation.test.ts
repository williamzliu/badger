import assert from 'node:assert/strict';
import { openDatabase } from './db.js';
import { SessionStore } from './sessions.js';

const store = new SessionStore(openDatabase(':memory:'));
const session = store.create({ hostName: 'Kaustubh', goal: 'See The Odyssey this weekend' });
assert.equal(session.status, 'DRAFT');
const participant = store.addParticipant(session, { name: 'Alex', phone: '+15550000001' });
assert.equal(participant.required, true);
assert.equal(store.get(session.id)!.participants[0].name, 'Alex');
assert.equal(store.receiveWebhook('cartesia', 'webhook-1'), false);
assert.equal(store.receiveWebhook('cartesia', 'webhook-1'), true);
assert.equal(store.receiveWebhook('spectrum', 'webhook-1'), false);
store.releaseWebhook('cartesia', 'webhook-1');
assert.equal(store.receiveWebhook('cartesia', 'webhook-1'), false);
console.info('foundation test passed');
