import assert from 'node:assert/strict';
import type { Session } from '../shared/types.js';
import { groundInboundDecision, instantInboundDecision } from './communications.js';
import { OpenAIFastInboundPlanner } from './fast-inbound.js';

const session: Session = {
  id: 'fast-session', hostName: 'Host', goal: 'See a movie this weekend', status: 'COLLECTING',
  createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  candidates: [{ id: 'movie', theater: 'Example Cinema', time: 'Saturday 6 PM', slot: 'saturday_evening', format: 'IMAX', price: 20, location: 'San Francisco' }],
  participants: [{ id: 'person', sessionId: 'fast-session', name: 'Alex', phone: '+15550000123', required: true, status: 'TEXTED' }],
};

let requestBody: Record<string, unknown> = {};
const planner = new OpenAIFastInboundPlanner({
  apiKey: 'openai-key',
  fetch: async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ output: [{
      type: 'function_call', name: 'interpret_inbound_message',
      arguments: JSON.stringify({
        action: 'ASK_FOLLOWUP', channel: 'CALL', message: 'What other day or time could work?',
        reason: 'A callback is the quickest way to clarify the reply.', availability: [], hardVetoes: [],
        softPreferences: [], flexibility: 0.5, summary: '',
      }),
    }] }), { status: 200 });
  },
});

const decision = await planner.interpretMessage(session, session.participants[0]!, "no it doesn't");
assert.equal(requestBody.model, 'gpt-4.1-nano');
assert.equal(requestBody.reasoning, undefined);
assert.equal(requestBody.background, undefined);
const tools = requestBody.tools as Array<{ parameters?: { properties?: { action?: { enum?: string[] } } } }>;
assert.deepEqual(tools[0]?.parameters?.properties?.action?.enum, ['RECORD_PREFERENCES', 'ASK_FOLLOWUP']);
assert.equal(decision.action, 'ASK_FOLLOWUP');
assert.equal(decision.channel, 'CALL');

const sundaySession: Session = {
  ...session,
  status: 'RESOLVING',
  selectedCandidateId: 'sunday-afternoon',
  candidates: [
    {
      id: 'sunday-afternoon', theater: 'Example Cinema', time: '2026-08-02 3:00 PM',
      slot: 'sunday_afternoon', format: 'IMAX', price: 20, location: 'San Francisco',
    },
    {
      id: 'sunday-evening', theater: 'Example Cinema', time: '2026-08-02 7:00 PM',
      slot: 'sunday_evening', format: 'IMAX', price: 20, location: 'San Francisco',
    },
  ],
  participants: [{
    ...session.participants[0]!,
    status: 'NEEDS_FOLLOWUP',
    preferences: {
      availability: ['friday_evening'], hardVetoes: [], preferences: [],
      flexibility: 0.7, summary: 'Friday evening works',
    },
  }],
};
assert.equal(
  instantInboundDecision(sundaySession, sundaySession.participants[0]!, 'Sunday')?.action,
  'ASK_FOLLOWUP',
);
assert.equal(
  instantInboundDecision(sundaySession, sundaySession.participants[0]!, 'Sunday works')?.action,
  'ACCEPT_ACTIVE_OPTION',
);
assert.equal(
  instantInboundDecision(sundaySession, sundaySession.participants[0]!, "No, Sunday doesn't work")?.action,
  'REJECT_ACTIVE_OPTION',
);
const later = instantInboundDecision(
  sundaySession,
  sundaySession.participants[0]!,
  'Hmm not 3pm, can we do later in the day?',
);
assert.equal(later?.action, 'REJECT_ACTIVE_OPTION');
assert.deepEqual(later?.preferences.availability, ['sunday_evening']);
const grounded = groundInboundDecision(
  sundaySession,
  sundaySession.participants[0]!,
  'Can we do later?',
  {
    action: 'ASK_FOLLOWUP', channel: 'SMS',
    message: 'Would 7 PM Sunday at Example Cinema work for you?',
    reason: 'Offer a concrete later option.',
    preferences: sundaySession.participants[0]!.preferences!,
  },
);
assert.equal(grounded.action, 'REJECT_ACTIVE_OPTION');
assert.deepEqual(grounded.preferences.availability, ['sunday_evening']);
console.info('fast inbound planner test passed');
