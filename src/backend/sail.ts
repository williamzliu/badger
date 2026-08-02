import { createHash } from 'node:crypto';
import type { Session } from '../shared/types.js';

export type PlannerDecision = {
  action: 'REQUEST_FLEXIBILITY' | 'PROPOSE_PLAN';
  candidateId: string;
  participantId: string | null;
  message: string;
  reason: string;
};

export interface GroupPlanner {
  recommend(session: Session): Promise<PlannerDecision>;
}

type SailPlannerConfig = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

function parseDecision(value: unknown): PlannerDecision {
  if (typeof value !== 'object' || value === null) throw new Error('Sail returned no planner decision');
  const decision = value as Record<string, unknown>;
  if (decision.action !== 'REQUEST_FLEXIBILITY' && decision.action !== 'PROPOSE_PLAN') {
    throw new Error('Sail returned an invalid planner action');
  }
  if (typeof decision.candidateId !== 'string' || !decision.candidateId) throw new Error('Sail omitted candidateId');
  if (decision.participantId !== null && typeof decision.participantId !== 'string') {
    throw new Error('Sail returned an invalid participantId');
  }
  if (typeof decision.message !== 'string' || !decision.message.trim()) throw new Error('Sail omitted message');
  if (typeof decision.reason !== 'string' || !decision.reason.trim()) throw new Error('Sail omitted reason');
  return decision as PlannerDecision;
}

export function validateDecision(session: Session, decision: PlannerDecision): PlannerDecision {
  if (decision.candidateId !== session.selectedCandidateId) throw new Error('Planner changed the selected candidate');
  if (session.status === 'RESOLVING') {
    const target = session.participants.find((participant) => participant.status === 'NEEDS_FOLLOWUP');
    if (decision.action !== 'REQUEST_FLEXIBILITY' || decision.participantId !== target?.id) {
      throw new Error('Planner changed the deterministic flexibility target');
    }
  } else if (session.status === 'PROPOSING') {
    if (decision.action !== 'PROPOSE_PLAN' || decision.participantId !== null) {
      throw new Error('Planner returned the wrong action for a proposal');
    }
  } else {
    throw new Error(`Planner cannot act while session is ${session.status}`);
  }
  return decision;
}

export class SailPlanner implements GroupPlanner {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: SailPlannerConfig) {
    if (!config.apiKey) throw new Error('Sail apiKey is required');
    this.baseUrl = (config.baseUrl ?? 'https://api.sailresearch.com/v1').replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async recommend(session: Session): Promise<PlannerDecision> {
    const snapshot = {
      id: session.id,
      status: session.status,
      goal: session.goal,
      selectedCandidateId: session.selectedCandidateId,
      candidates: session.candidates,
      participants: session.participants.map(({ phone: _phone, ...participant }) => participant),
    };
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      },
      body: JSON.stringify({
        model: this.config.model ?? 'zai-org/GLM-5.2-FP8',
        instructions: 'You write one concise coordination message. Never alter the supplied candidate or target. Never reveal another participant\'s private preferences.',
        input: JSON.stringify(snapshot),
        tools: [{
          type: 'function',
          name: 'recommend_action',
          description: 'Return the message for the deterministic next coordination action.',
          strict: true,
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'candidateId', 'participantId', 'message', 'reason'],
            properties: {
              action: { type: 'string', enum: ['REQUEST_FLEXIBILITY', 'PROPOSE_PLAN'] },
              candidateId: { type: 'string' },
              participantId: { type: ['string', 'null'] },
              message: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        }],
        tool_choice: { type: 'function', name: 'recommend_action' },
        max_output_tokens: 600,
        metadata: { completion_window: 'asap' },
        store: false,
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Sail planner failed (${response.status}): ${raw || response.statusText}`);
    const body = JSON.parse(raw) as { output?: Array<{ type?: string; name?: string; arguments?: string }> };
    const call = body.output?.find((item) => item.type === 'function_call' && item.name === 'recommend_action');
    if (!call?.arguments) throw new Error('Sail response did not call recommend_action');
    return validateDecision(session, parseDecision(JSON.parse(call.arguments) as unknown));
  }
}
