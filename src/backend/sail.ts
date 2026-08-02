import { createHash } from 'node:crypto';
import type { Session } from '../shared/types.js';

export type PlannerDecision = {
  action: 'REQUEST_FLEXIBILITY' | 'PROPOSE_PLAN' | 'COMMIT_PLAN';
  candidateId: string;
  participantId: string | null;
  message: string;
  reason: string;
};

export type PlannerOutcome = {
  ok: boolean;
  detail: string;
};

export interface GroupPlanner {
  recommend(session: Session): Promise<PlannerDecision>;
  recordOutcome(sessionId: string, decision: PlannerDecision, outcome: PlannerOutcome): Promise<void>;
}

type ConversationItem = Record<string, unknown>;

type SailPlannerConfig = {
  apiKey: string;
  loadHistory: (sessionId: string) => ConversationItem[] | Promise<ConversationItem[]>;
  saveHistory: (sessionId: string, history: ConversationItem[]) => void | Promise<void>;
  model?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

function parseDecision(value: unknown): PlannerDecision {
  if (typeof value !== 'object' || value === null) throw new Error('Sail returned no planner decision');
  const decision = value as Record<string, unknown>;
  if (!['REQUEST_FLEXIBILITY', 'PROPOSE_PLAN', 'COMMIT_PLAN'].includes(String(decision.action))) {
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
  } else if (session.status === 'COMMITTED') {
    if (decision.action !== 'COMMIT_PLAN' || decision.participantId !== null) {
      throw new Error('Planner returned the wrong action for commitment');
    }
  } else {
    throw new Error(`Planner cannot act while session is ${session.status}`);
  }
  return decision;
}

function closeDanglingCalls(history: ConversationItem[]): ConversationItem[] {
  const completed = new Set(history
    .filter((item) => item.type === 'function_call_output' && typeof item.call_id === 'string')
    .map((item) => item.call_id as string));
  const dangling = history.filter((item) =>
    item.type === 'function_call' && typeof item.call_id === 'string' && !completed.has(item.call_id));
  if (!dangling.length) return history;
  return [...history, ...dangling.map((item) => ({
    type: 'function_call_output',
    call_id: item.call_id,
    output: JSON.stringify({ ok: false, detail: 'Outcome unavailable after coordinator restart' }),
  }))];
}

function sessionSnapshot(session: Session) {
  return {
    id: session.id,
    status: session.status,
    goal: session.goal,
    selectedCandidateId: session.selectedCandidateId,
    candidates: session.candidates,
    participants: session.participants.map(({ phone: _phone, ...participant }) => participant),
  };
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
    const history = closeDanglingCalls(await this.config.loadHistory(session.id));
    const snapshot = sessionSnapshot(session);
    const input: ConversationItem[] = [
      ...history,
      { role: 'user', content: `Current authoritative coordination state:\n${JSON.stringify(snapshot)}` },
    ];
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      },
      body: JSON.stringify({
        model: this.config.model ?? 'zai-org/GLM-5.2-FP8',
        instructions: `You are Badger's long-lived group coordinator. Use all prior state updates, your prior tool calls, and their execution results. Choose exactly one valid next action. The backend state is authoritative: never change the selected candidate or flexibility target, never violate a hard veto, and never reveal one participant's private answers to another. Write concise messages that tell recipients how to respond.`,
        input,
        tools: [{
          type: 'function',
          name: 'coordinate_group',
          description: 'Choose and phrase the next validated group-coordination action.',
          strict: true,
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'candidateId', 'participantId', 'message', 'reason'],
            properties: {
              action: { type: 'string', enum: ['REQUEST_FLEXIBILITY', 'PROPOSE_PLAN', 'COMMIT_PLAN'] },
              candidateId: { type: 'string' },
              participantId: { type: ['string', 'null'] },
              message: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        }],
        tool_choice: { type: 'function', name: 'coordinate_group' },
        parallel_tool_calls: false,
        max_output_tokens: 600,
        metadata: { completion_window: 'asap', badger_session_id: session.id },
        store: false,
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Sail planner failed (${response.status}): ${raw || response.statusText}`);
    const body = JSON.parse(raw) as { output?: ConversationItem[] };
    const output = body.output ?? [];
    const call = output.find((item) => item.type === 'function_call' && item.name === 'coordinate_group');
    if (typeof call?.arguments !== 'string' || typeof call.call_id !== 'string') {
      throw new Error('Sail response did not call coordinate_group');
    }
    const decision = validateDecision(session, parseDecision(JSON.parse(call.arguments) as unknown));
    await this.config.saveHistory(session.id, [...input, ...output]);
    return decision;
  }

  async recordOutcome(sessionId: string, decision: PlannerDecision, outcome: PlannerOutcome): Promise<void> {
    const history = await this.config.loadHistory(sessionId);
    const completed = new Set(history
      .filter((item) => item.type === 'function_call_output' && typeof item.call_id === 'string')
      .map((item) => item.call_id as string));
    const call = [...history].reverse().find((item) => {
      if (item.type !== 'function_call' || item.name !== 'coordinate_group' || typeof item.call_id !== 'string') return false;
      if (completed.has(item.call_id)) return false;
      if (typeof item.arguments !== 'string') return false;
      try {
        return (JSON.parse(item.arguments) as { action?: unknown }).action === decision.action;
      } catch {
        return false;
      }
    });
    if (typeof call?.call_id !== 'string') throw new Error('No pending Sail action to complete');
    await this.config.saveHistory(sessionId, [...history, {
      type: 'function_call_output',
      call_id: call.call_id,
      output: JSON.stringify(outcome),
    }]);
  }
}
