import type { Participant, Session } from '../shared/types.js';
import { parseInboundDecision, type InboundMessageDecision } from './sail.js';

export interface InboundMessagePlanner {
  interpretMessage(session: Session, participant: Participant, body: string): Promise<InboundMessageDecision>;
}

type FastInboundPlannerConfig = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

function hasActiveOption(session: Session, participant: Participant): boolean {
  return Boolean(session.selectedCandidateId) && (
    (session.status === 'PROPOSING' && participant.status === 'PROPOSED') ||
    (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP')
  );
}

export class OpenAIFastInboundPlanner implements InboundMessagePlanner {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: FastInboundPlannerConfig) {
    if (!config.apiKey) throw new Error('OpenAI apiKey is required for fast inbound planning');
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async interpretMessage(
    session: Session,
    participant: Participant,
    body: string,
  ): Promise<InboundMessageDecision> {
    const model = this.config.model ?? 'gpt-4.1-nano';
    const activeOption = hasActiveOption(session, participant);
    const actions = activeOption
      ? ['RECORD_PREFERENCES', 'ACCEPT_ACTIVE_OPTION', 'REJECT_ACTIVE_OPTION', 'ASK_FOLLOWUP', 'RESPOND_WITH_CONTEXT', 'CHANGE_PLAN']
      : ['RECORD_PREFERENCES', 'ASK_FOLLOWUP', 'RESPOND_WITH_CONTEXT', 'CHANGE_PLAN'];
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 2_000),
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        ...(model.startsWith('gpt-5') ? { reasoning: { effort: 'none' } } : {}),
        input: [{
          role: 'system',
          content: 'Interpret one message to a conversational group-planning agent. Do not force every message into scheduling. RESPOND_WITH_CONTEXT answers a question about the activity, researched options, current proposal, tradeoffs, or Badger itself without changing state. Use only the supplied context, admit when a live detail is unknown, and never expose another participant\'s private constraints. CHANGE_PLAN applies to a material change of activity, venue, city, or overall goal; updatedGoal must be a complete replacement goal preserving unchanged timing/location context. A different day or time is a REJECT_ACTIVE_OPTION counterproposal, not CHANGE_PLAN. ASK_FOLLOWUP is only for genuinely missing information and must not repeat an option the sender just tried to change. STOP is handled elsewhere. Keep replies natural and under 45 words. Never invent availability. Keep the reason group-level and privacy-safe.',
        }, {
          role: 'user',
          content: JSON.stringify({
            goal: session.goal,
            sessionStatus: session.status,
            activeOption,
            selectedCandidate: session.candidates.find((candidate) => candidate.id === session.selectedCandidateId),
            candidates: session.candidates.map(({ id, time, slot, theater, format, location }) => ({
              id, time, slot, theater, format, location,
            })),
            participant: {
              id: participant.id,
              status: participant.status,
              existingPreferences: participant.preferences,
            },
            message: body,
          }),
        }],
        tools: [{
          type: 'function',
          name: 'interpret_inbound_message',
          description: 'Choose the next validated coordination action for this participant text.',
          strict: true,
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: [
              'action', 'channel', 'message', 'reason', 'availability', 'hardVetoes',
              'softPreferences', 'flexibility', 'summary', 'updatedGoal',
            ],
            properties: {
              action: { type: 'string', enum: actions },
              channel: { type: 'string', enum: ['SMS', 'CALL'] },
              message: { type: 'string', minLength: 1 },
              reason: { type: 'string', minLength: 1 },
              availability: { type: 'array', items: { type: 'string' } },
              hardVetoes: { type: 'array', items: { type: 'string' } },
              softPreferences: { type: 'array', items: { type: 'string' } },
              flexibility: { type: 'number', minimum: 0, maximum: 1 },
              summary: { type: 'string' },
              updatedGoal: { type: 'string' },
            },
          },
        }],
        tool_choice: { type: 'function', name: 'interpret_inbound_message' },
        max_output_tokens: 220,
        prompt_cache_key: 'badger:fast-inbound:v2',
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Fast inbound planning failed (${response.status}): ${raw || response.statusText}`);
    }
    const payload = JSON.parse(raw) as { output?: Array<Record<string, unknown>> };
    const call = payload.output?.find(
      (item) => item.type === 'function_call' && item.name === 'interpret_inbound_message',
    );
    if (typeof call?.arguments !== 'string') throw new Error('Fast inbound planner omitted its decision');
    const decision = JSON.parse(call.arguments) as Record<string, unknown>;
    if (!['ASK_FOLLOWUP', 'RESPOND_WITH_CONTEXT', 'CHANGE_PLAN'].includes(String(decision.action))) {
      decision.channel = 'NONE';
    }
    return parseInboundDecision(decision);
  }
}
