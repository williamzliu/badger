import assert from 'node:assert/strict';
import { createServer } from './server.js';

const { app } = createServer();
const created = await app.inject({ method: 'POST', url: '/sessions', payload: { hostName: 'Kaustubh', goal: 'Movie' } });
assert.equal(created.statusCode, 201);
const session = created.json();

const participant = await app.inject({ method: 'POST', url: `/sessions/${session.id}/participants`, payload: { name: 'Alex', phone: '+15550000001' } });
assert.equal(participant.statusCode, 201);

const started = await app.inject({ method: 'POST', url: `/sessions/${session.id}/start` });
assert.equal(started.statusCode, 200);
assert.equal(started.json().status, 'COLLECTING');

const fetched = await app.inject({ method: 'GET', url: `/sessions/${session.id}` });
assert.equal(fetched.json().participants[0].status, 'TEXTED');

process.env.BADGER_TOOL_SECRET = 'test-tool-secret';
const unauthorizedPreferences = await app.inject({
  method: 'POST',
  url: '/internal/preferences',
  payload: {
    sessionId: session.id,
    participantId: participant.json().id,
    availability: ['friday_after_8'],
    hardVetoes: [],
    preferences: ['imax'],
    flexibility: 0.5,
    summary: 'Friday works',
  },
});
assert.equal(unauthorizedPreferences.statusCode, 401);
delete process.env.BADGER_TOOL_SECRET;

await app.close();
console.info('API test passed');
