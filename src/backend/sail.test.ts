import assert from 'node:assert/strict';
import type { Session } from '../shared/types.js';
import { SailPlanner } from './sail.js';

const session: Session = {
  id: 'session',
  hostName: 'Host',
  goal: 'Movie',
  status: 'RESOLVING',
  selectedCandidateId: 'candidate',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  candidates: [{ id: 'candidate', theater: 'AMC', time: 'Friday 9 PM', slot: 'friday', format: 'IMAX', price: 20, location: 'SF' }],
  participants: [{ id: 'person', sessionId: 'session', name: 'Alex', phone: '+15550000123', required: true, status: 'NEEDS_FOLLOWUP' }],
};
let authorization = '';
let requestBody = '';
const planner = new SailPlanner({
  apiKey: 'sail-secret',
  fetch: async (_url, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ output: [{
      type: 'function_call',
      name: 'recommend_action',
      arguments: JSON.stringify({
        action: 'REQUEST_FLEXIBILITY',
        candidateId: 'candidate',
        participantId: 'person',
        message: 'Could Friday at 9 work?',
        reason: 'Only open conflict',
      }),
    }] }), { status: 200 });
  },
});
const decision = await planner.recommend(session);
assert.equal(authorization, 'Bearer sail-secret');
assert.equal(decision.participantId, 'person');
assert.equal(requestBody.includes('+15550000123'), false);
console.info('Sail planner test passed');
