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
  candidates: [{ id: 'candidate', theater: 'Group activity', time: 'Friday evening', slot: 'friday_evening', format: 'Activity', price: 0, location: 'TBD' }],
  participants: [{
    id: 'person', sessionId: 'session', name: 'Alex', phone: '+15550000123', required: true, status: 'NEEDS_FOLLOWUP',
    preferences: { availability: ['saturday_afternoon'], hardVetoes: [], preferences: [], flexibility: 0.8, summary: 'Saturday works' },
  }],
};
let history: Record<string, unknown>[] = [];
const requests: Array<Record<string, unknown>> = [];
let authorization = '';
let turn = 0;
let callSequence = 0;
const decisionReasoning: string[] = [];
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
      channel: turn === 1 ? 'CALL' : 'SMS',
      delaySeconds: turn === 1 ? 5 : 0,
    }),
  }] }), { status: 200 });
};
const config = {
  apiKey: 'sail-secret',
  completionWindow: 'asap' as const,
  fetch: fetchImpl,
  loadHistory: () => history,
  saveHistory: (_sessionId: string, next: Record<string, unknown>[]) => { history = next; },
  emitReasoning: (_sessionId: string, summary: string) => { decisionReasoning.push(summary); },
};

const firstPlanner = new SailPlanner(config);
const flexibility = await firstPlanner.recommend(session);
await firstPlanner.recordOutcome(session.id, flexibility, { ok: true, detail: 'Message sent' });
assert.equal(flexibility.participantId, 'person');

session.status = 'PROPOSING';
session.participants[0]!.status = 'PROPOSED';
session.participants[0]!.preferences = { availability: ['friday_evening'], hardVetoes: [], preferences: [], flexibility: 0.8, summary: 'Friday works' };
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
assert.equal((requests[0]?.metadata as { completion_window?: string })?.completion_window, 'asap');
const proposalInput = requests[1]?.input as Record<string, unknown>[];
assert.equal(proposalInput[0]?.role, 'system');
assert.ok(proposalInput.some((item) => item.type === 'function_call' && item.call_id === 'call_1'));
assert.ok(proposalInput.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1'));
assert.equal(history.at(-1)?.type, 'function_call_output');
assert.equal(decisionReasoning.some((summary) => summary.startsWith('Decision · ')), true);

const preparationHistory: Record<string, unknown>[] = [];
const preparationReasoning: string[] = [];
const preparePlanner = new SailPlanner({
  apiKey: 'sail-secret',
  completionWindow: 'priority',
  loadHistory: () => preparationHistory,
  saveHistory: (_sessionId, next) => {
    preparationHistory.splice(0, preparationHistory.length, ...next);
  },
  emitReasoning: (_sessionId, summary) => { preparationReasoning.push(summary); },
  researcher: {
    async research(input) {
      assert.match(input.query, /current bookable options/i);
      return [
        { id: 'researched_1', theater: 'K1 Speed', time: 'Thursday 7 PM', slot: 'thursday_evening', format: 'Go-karting', price: 35, location: 'South San Francisco', sourceUrl: 'https://example.com/k1', evidence: 'Open Thursday evening' },
        { id: 'researched_2', theater: 'Mini Golf', time: 'Friday 6 PM', slot: 'friday_evening', format: 'Mini golf', price: 20, location: 'San Francisco', sourceUrl: 'https://example.com/golf', evidence: 'Reservations offered' },
      ];
    },
  },
  fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { tool_choice?: { name?: string }; reasoning?: { effort?: string }; prompt_cache_key?: string; metadata?: { completion_window?: string } };
    assert.equal(request.reasoning?.effort, 'low');
    assert.equal(request.prompt_cache_key, 'badger:session');
    assert.equal(request.metadata?.completion_window, 'priority');
    if (request.tool_choice?.name === 'interpret_inbound_message') {
      return new Response(JSON.stringify({ output: [{
        type: 'function_call', call_id: 'inbound_call', name: 'interpret_inbound_message',
        arguments: JSON.stringify({
          action: 'ASK_FOLLOWUP',
          channel: 'CALL',
          message: 'What other day or time could work for you?',
          reason: 'A quick callback will clarify the open scheduling question.',
          availability: [],
          hardVetoes: [],
          softPreferences: [],
          flexibility: 0.5,
          summary: '',
        }),
      }] }), { status: 200 });
    }
    assert.equal(request.tool_choice?.name, 'launch_coordination');
    return new Response(JSON.stringify({ output: [{
      type: 'function_call', call_id: 'launch_call', name: 'launch_coordination',
      arguments: JSON.stringify({
        // An advisory model can occasionally echo or invent an ID despite the
        // enum. Unknown IDs must be dropped and replaced with real research.
        candidateIds: ['researched_1', 'invented_candidate'],
        outreach: { person: { channel: 'CALL_ONLY', delaySeconds: 2, callAfterSeconds: 0, message: 'Ask for broad availability.', reason: 'Call first to gather constraints' } },
        insights: ['Evidence · Two sourced activities survived review.', 'Plan · Call first and use SMS only if the call fails.'],
        reason: 'Research first, then call the participant promptly',
      }),
    }] }), { status: 200 });
  },
});
const preparationSession: Session = {
  ...session,
  status: 'DRAFT',
  selectedCandidateId: undefined,
  candidates: [],
  participants: [{ ...session.participants[0]!, status: 'PENDING', preferences: undefined }],
};
const prepared = await preparePlanner.prepare(preparationSession);
assert.equal(prepared.candidates[0]?.theater, 'K1 Speed');
assert.equal(prepared.candidates[1]?.theater, 'Mini Golf');
assert.equal(prepared.outreach[0]?.channel, 'CALL_ONLY');
assert.ok(preparationHistory.some((item) => item.type === 'function_call_output' && item.call_id === 'launch_call'));
assert.deepEqual(preparationReasoning, [
  'Evidence · Two sourced activities survived review.',
  'Plan · Calls are already underway while Sail prepares the option and conflict strategy.',
]);

let fallbackHistory: Record<string, unknown>[] = [];
const fallbackPlanner = new SailPlanner({
  apiKey: 'sail-secret',
  loadHistory: () => fallbackHistory,
  saveHistory: (_sessionId, next) => { fallbackHistory = next; },
  researcher: {
    async research() {
      return [
        { id: 'fallback_1', theater: 'Balboa', time: 'Sunday 3 PM', slot: 'sunday_afternoon', format: 'Digital', price: 0, location: 'San Francisco', sourceUrl: 'https://example.com/3', evidence: 'Listed at 3 PM' },
        { id: 'fallback_2', theater: 'Balboa', time: 'Sunday 7 PM', slot: 'sunday_evening', format: 'Digital', price: 0, location: 'San Francisco', sourceUrl: 'https://example.com/7', evidence: 'Listed at 7 PM' },
      ];
    },
  },
  fetch: async () => new Response('temporary failure', { status: 503 }),
});
const fallbackPrepared = await fallbackPlanner.prepare(preparationSession);
assert.deepEqual(fallbackPrepared.candidates.map((candidate) => candidate.id), ['fallback_1', 'fallback_2']);
assert.equal(fallbackHistory.some((item) => String(item.content).includes('retained all authoritative sourced options')), true);
preparationSession.status = 'COLLECTING';
preparationSession.participants[0]!.status = 'TEXTED';
const inboundDecision = await preparePlanner.interpretMessage(
  preparationSession,
  preparationSession.participants[0]!,
  "no it doesn't",
);
assert.equal(inboundDecision.action, 'ASK_FOLLOWUP');
assert.equal(inboundDecision.channel, 'CALL');
assert.match(inboundDecision.message, /other day or time/i);
console.info('Sail long-lived planner test passed');
