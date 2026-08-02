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
let history: Record<string, unknown>[] = [];
const requests: Array<Record<string, unknown>> = [];
let authorization = '';
let turn = 0;
let callSequence = 0;
const fetchImpl: typeof fetch = async (_url, init) => {
  authorization = new Headers(init?.headers).get('authorization') ?? '';
  const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
  requests.push(request);
  callSequence += 1;
  turn += 1;
  const action = turn === 1 ? 'REQUEST_FLEXIBILITY' : turn === 2 ? 'PROPOSE_PLAN' : 'COMMIT_PLAN';
  return new Response(JSON.stringify({ output: [{
    type: 'function_call',
    call_id: `call_${callSequence}`,
    name: 'coordinate_group',
    arguments: JSON.stringify({
      action,
      candidateId: 'candidate',
      participantId: turn === 1 ? 'person' : null,
      message: turn === 1 ? 'Could Friday at 9 work?' : turn === 2 ? 'Friday at 9 is the plan. Reply YES.' : 'Locked: Friday at 9.',
      reason: 'Best valid option',
    }),
  }] }), { status: 200 });
};
const config = {
  apiKey: 'sail-secret',
  fetch: fetchImpl,
  loadHistory: () => history,
  saveHistory: (_sessionId: string, next: Record<string, unknown>[]) => { history = next; },
};

const firstPlanner = new SailPlanner(config);
const flexibility = await firstPlanner.recommend(session);
await firstPlanner.recordOutcome(session.id, flexibility, { ok: true, detail: 'Message sent' });
assert.equal(flexibility.participantId, 'person');

session.status = 'PROPOSING';
session.participants[0]!.status = 'PROPOSED';
const restartedPlanner = new SailPlanner(config);
const proposal = await restartedPlanner.recommend(session);
await restartedPlanner.recordOutcome(session.id, proposal, { ok: true, detail: 'Proposal sent' });

session.status = 'COMMITTED';
session.participants[0]!.status = 'CONFIRMED';
const commitmentPlanner = new SailPlanner(config);
const commitment = await commitmentPlanner.recommend(session);
await commitmentPlanner.recordOutcome(session.id, commitment, { ok: true, detail: 'Commitment sent' });

assert.equal(authorization, 'Bearer sail-secret');
assert.equal(proposal.action, 'PROPOSE_PLAN');
assert.equal(commitment.action, 'COMMIT_PLAN');
assert.equal(JSON.stringify(requests).includes('+15550000123'), false);
assert.equal('instructions' in requests[0]!, false);
assert.equal('parallel_tool_calls' in requests[0]!, false);
const proposalInput = requests[1]?.input as Record<string, unknown>[];
assert.equal(proposalInput[0]?.role, 'system');
assert.ok(proposalInput.some((item) => item.type === 'function_call' && item.call_id === 'call_1'));
assert.ok(proposalInput.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1'));
assert.equal(history.at(-1)?.type, 'function_call_output');
console.info('Sail long-lived planner test passed');
