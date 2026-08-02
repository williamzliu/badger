import { createHash } from 'node:crypto';
import type { Candidate, Participant, Preferences, Session } from '../shared/types.js';
import type { OptionResearcher, ResearchedCandidate } from './research.js';
import { isCandidateFeasible, matchesCandidateConstraint } from './state-machine.js';

export type PlannerDecision = {
  action: 'REQUEST_FLEXIBILITY' | 'PROPOSE_PLAN' | 'COMMIT_PLAN';
  candidateId: string;
  participantId: string | null;
  message: string;
  reason: string;
  channel: 'SMS' | 'CALL';
  delaySeconds: number;
};

export type PlannerOutcome = {
  ok: boolean;
  detail: string;
};

export type InboundMessageDecision = {
  action:
    | 'RECORD_PREFERENCES'
    | 'ACCEPT_ACTIVE_OPTION'
    | 'REJECT_ACTIVE_OPTION'
    | 'ASK_FOLLOWUP'
    | 'RESPOND_WITH_CONTEXT'
    | 'CHANGE_PLAN';
  channel: 'NONE' | 'SMS' | 'CALL';
  message: string;
  reason: string;
  preferences: Preferences;
  updatedGoal?: string;
};

export type OutreachStep = {
  participantId: string;
  channel: 'TEXT_THEN_CALL' | 'TEXT_ONLY' | 'CALL_ONLY';
  delaySeconds: number;
  callAfterSeconds: number;
  message: string;
  reason: string;
};

export type CoordinationPreparation = {
  candidates: Candidate[];
  research: ResearchedCandidate[];
  outreach: OutreachStep[];
  insights: string[];
  reason: string;
};

export type SailCompletionWindow = 'asap' | 'priority' | 'standard' | 'flex';

export interface GroupPlanner {
  prewarm?(session: Session): Promise<void>;
  prepare?(session: Session, options?: { replanning?: boolean }): Promise<CoordinationPreparation>;
  observeMessage?(session: Session, participant: Participant, body: string): Promise<void>;
  observeInboundDecision?(sessionId: string, participant: Participant, decision: InboundMessageDecision): Promise<void>;
  interpretMessage?(session: Session, participant: Participant, body: string): Promise<InboundMessageDecision>;
  recommend(session: Session, options?: { emitReasoning?: boolean }): Promise<PlannerDecision>;
  recordOutcome(sessionId: string, decision: PlannerDecision, outcome: PlannerOutcome): Promise<void>;
}

type ConversationItem = Record<string, unknown>;

type SailPlannerConfig = {
  apiKey: string;
  loadHistory: (sessionId: string) => ConversationItem[] | Promise<ConversationItem[]>;
  saveHistory: (sessionId: string, history: ConversationItem[]) => void | Promise<void>;
  appendHistory?: (sessionId: string, items: ConversationItem[]) => void | Promise<void>;
  model?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  completionWindow?: SailCompletionWindow;
  fetch?: typeof globalThis.fetch;
  researcher?: OptionResearcher;
  locationHint?: string;
  emitReasoning?: (sessionId: string, summary: string) => void | Promise<void>;
  emitProgress?: (sessionId: string, summary: string) => void | Promise<void>;
};

function reasoningSummary(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Sail omitted ${field}`);
  const summary = value.trim().replace(/\s+/g, ' ');
  if (summary.length > 280) throw new Error(`Sail ${field} was too long`);
  return summary;
}

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
  decision.reason = reasoningSummary(decision.reason, 'reason');
  if (!['SMS', 'CALL'].includes(String(decision.channel))) throw new Error('Sail returned an invalid channel');
  if (!Number.isFinite(decision.delaySeconds) || Number(decision.delaySeconds) < 0 || Number(decision.delaySeconds) > 120) {
    throw new Error('Sail returned an invalid action delay');
  }
  return decision as PlannerDecision;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Sail returned invalid ${field}`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

export function parseInboundDecision(value: unknown): InboundMessageDecision {
  if (!value || typeof value !== 'object') throw new Error('Sail returned no inbound-message decision');
  const raw = value as Record<string, unknown>;
  if (![
    'RECORD_PREFERENCES', 'ACCEPT_ACTIVE_OPTION', 'REJECT_ACTIVE_OPTION',
    'ASK_FOLLOWUP', 'RESPOND_WITH_CONTEXT', 'CHANGE_PLAN',
  ].includes(String(raw.action))) {
    throw new Error('Sail returned an invalid inbound-message action');
  }
  if (!['NONE', 'SMS', 'CALL'].includes(String(raw.channel))) {
    throw new Error('Sail returned an invalid inbound-message channel');
  }
  if (typeof raw.message !== 'string') throw new Error('Sail omitted the inbound follow-up message');
  const flexibility = Number(raw.flexibility);
  if (!Number.isFinite(flexibility) || flexibility < 0 || flexibility > 1) {
    throw new Error('Sail returned invalid inbound flexibility');
  }
  const decision: InboundMessageDecision = {
    action: raw.action as InboundMessageDecision['action'],
    channel: raw.channel as InboundMessageDecision['channel'],
    message: raw.message.trim(),
    reason: reasoningSummary(raw.reason, 'inbound reason'),
    preferences: {
      availability: stringList(raw.availability, 'inbound availability'),
      hardVetoes: stringList(raw.hardVetoes, 'inbound hard vetoes'),
      preferences: stringList(raw.softPreferences, 'inbound soft preferences'),
      flexibility,
      summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    },
    updatedGoal: typeof raw.updatedGoal === 'string' ? raw.updatedGoal.trim() : '',
  };
  if (['ASK_FOLLOWUP', 'RESPOND_WITH_CONTEXT', 'CHANGE_PLAN'].includes(decision.action) &&
    (decision.channel === 'NONE' || !decision.message)) {
    throw new Error('Sail conversational action must choose a channel and provide a message');
  }
  if (!['ASK_FOLLOWUP', 'RESPOND_WITH_CONTEXT', 'CHANGE_PLAN'].includes(decision.action) && decision.channel !== 'NONE') {
    throw new Error('Sail chose outreach for an action that should update state');
  }
  if (decision.action === 'RESPOND_WITH_CONTEXT' && decision.channel !== 'SMS') {
    throw new Error('Context replies must use SMS');
  }
  if (decision.action === 'CHANGE_PLAN' && (decision.channel !== 'SMS' || !decision.updatedGoal)) {
    throw new Error('Plan changes require an SMS acknowledgement and a complete updated goal');
  }
  if (decision.action === 'RECORD_PREFERENCES' && !decision.preferences.summary) {
    throw new Error('Sail omitted the preference summary');
  }
  return decision;
}

export function validateDecision(session: Session, decision: PlannerDecision): PlannerDecision {
  const candidate = session.candidates.find((item) => item.id === decision.candidateId);
  if (!candidate) throw new Error('Planner chose an unknown candidate');
  const required = session.participants.filter((participant) => participant.required);
  const violatesHardVeto = required.some((participant) => participant.preferences?.hardVetoes.some(
    (window) => matchesCandidateConstraint(window, candidate),
  ));
  if (violatesHardVeto) throw new Error('Planner chose a candidate that violates a hard veto');
  if (session.status === 'RESOLVING') {
    const target = required.find((participant) => participant.id === decision.participantId);
    if (decision.action !== 'REQUEST_FLEXIBILITY' || !target || isCandidateFeasible(candidate, target)) {
      throw new Error('Planner must target a required participant who blocks its candidate');
    }
  } else if (session.status === 'PROPOSING') {
    if (
      decision.action !== 'PROPOSE_PLAN' ||
      decision.participantId !== null ||
      !required.every((participant) => isCandidateFeasible(candidate, participant))
    ) {
      throw new Error('Planner returned the wrong action for a proposal');
    }
    if (decision.channel !== 'SMS') throw new Error('Group proposals must be sent by SMS');
  } else if (session.status === 'COMMITTED') {
    if (
      decision.action !== 'COMMIT_PLAN' ||
      decision.participantId !== null ||
      decision.channel !== 'SMS' ||
      decision.candidateId !== session.selectedCandidateId
    ) {
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

function sessionSnapshot(session: Session, includeCandidates = true) {
  return {
    id: session.id,
    status: session.status,
    goal: session.goal,
    selectedCandidateId: session.selectedCandidateId,
    ...(includeCandidates ? { candidates: session.candidates } : {}),
    participants: session.participants.map(({ phone: _phone, ...participant }) => participant),
  };
}

function researchBrief(session: Session, locationHint: string): string {
  return `Current bookable options for ${session.goal} near ${locationHint}`;
}

function parsePreparation(
  session: Session,
  researched: ResearchedCandidate[],
  value: unknown,
): CoordinationPreparation {
  if (!value || typeof value !== 'object') throw new Error('Sail returned no launch plan');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.candidateIds)) throw new Error('Sail launch plan omitted candidateIds');
  const byId = new Map(researched.map((candidate) => [candidate.id, candidate]));
  const requestedIds = raw.candidateIds.filter((id): id is string => typeof id === 'string');
  // Model-produced IDs are only ranking hints. Drop unknown values and
  // backfill exclusively from authoritative research instead of allowing an
  // advisory formatting mistake to take down the live coordination session.
  const candidateIds = [...new Set(requestedIds.filter((id) => byId.has(id)))];
  // Some compatible tool-call backends satisfy minItems by repeating one enum
  // value despite uniqueItems. Keep Sail's ranked choice and add researched
  // backups instead of throwing away an otherwise valid orchestration plan.
  for (const candidate of researched) {
    if (candidateIds.length >= Math.min(2, researched.length)) break;
    if (!candidateIds.includes(candidate.id)) candidateIds.push(candidate.id);
  }
  if (candidateIds.length < Math.min(2, researched.length)) {
    throw new Error('Sail launch plan did not retain enough researched options');
  }
  const selected = candidateIds.map((id) => byId.get(id));
  const selectedCandidates = selected.filter((candidate): candidate is ResearchedCandidate => Boolean(candidate));
  // Sail ranks the best options; it must not silently discard the rest of the
  // sourced research. Those backups are what let the state machine negotiate
  // a nearby alternative without launching another web search.
  const orderedCandidates = [
    ...selectedCandidates,
    ...researched.filter((candidate) => !candidateIds.includes(candidate.id)),
  ];
  if (!raw.outreach || typeof raw.outreach !== 'object' || Array.isArray(raw.outreach)) {
    throw new Error('Sail launch plan omitted outreach');
  }
  const rawOutreach = raw.outreach as Record<string, unknown>;
  const outreach = session.participants.map((participant, index) => {
    const item = rawOutreach[participant.id];
    if (!item || typeof item !== 'object') throw new Error(`Sail outreach step ${index + 1} was invalid`);
    const step = item as Record<string, unknown>;
    if (!['TEXT_THEN_CALL', 'TEXT_ONLY', 'CALL_ONLY'].includes(String(step.channel))) {
      throw new Error('Sail chose an invalid outreach channel');
    }
    const delaySeconds = Number(step.delaySeconds);
    const callAfterSeconds = Number(step.callAfterSeconds);
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 120) {
      throw new Error('Sail outreach delay must be between 0 and 120 seconds');
    }
    if (!Number.isFinite(callAfterSeconds) || callAfterSeconds < 0 || callAfterSeconds > 120) {
      throw new Error('Sail call delay must be between 0 and 120 seconds');
    }
    if (typeof step.message !== 'string' || !step.message.trim()) throw new Error('Sail outreach omitted a message');
    if (typeof step.reason !== 'string' || !step.reason.trim()) throw new Error('Sail outreach omitted a reason');
    return {
      participantId: participant.id,
      channel: step.channel as OutreachStep['channel'],
      delaySeconds,
      callAfterSeconds,
      message: step.message.trim(),
      reason: step.reason.trim(),
    };
  });
  if (!Array.isArray(raw.insights) || raw.insights.length < 2 || raw.insights.length > 4) {
    throw new Error('Sail launch plan must include two to four public insights');
  }
  const insights = raw.insights.map((insight, index) => reasoningSummary(insight, `launch insight ${index + 1}`));
  const launchReason = reasoningSummary(raw.reason, 'launch reason');
  return {
    candidates: orderedCandidates.map(({ sourceUrl: _sourceUrl, evidence: _evidence, ...candidate }) => candidate as Candidate),
    research: orderedCandidates,
    outreach,
    insights,
    reason: launchReason,
  };
}

function researchFallbackPreparation(
  session: Session,
  researched: ResearchedCandidate[],
  detail: string,
  replanning = false,
): CoordinationPreparation {
  return {
    candidates: researched.map(({ sourceUrl: _sourceUrl, evidence: _evidence, ...candidate }) => candidate as Candidate),
    research: researched,
    outreach: session.participants.map((participant) => ({
      participantId: participant.id,
      channel: 'CALL_ONLY',
      delaySeconds: 0,
      callAfterSeconds: 0,
      message: `Gather broad availability for ${session.goal}.`,
      reason: replanning
        ? 'Preserve the existing conversation; no duplicate call is needed.'
        : 'Calls are already underway; retain the call-first execution path.',
    })),
    insights: [
      `Evidence · ${researched.length} sourced options across ${new Set(researched.map((candidate) => candidate.slot)).size} time windows are available.`,
      replanning
        ? 'Plan · Preserve collected replies while matching them against the revised options.'
        : 'Plan · Calls are already underway while Badger matches replies against the sourced options.',
    ],
    reason: `Authoritative research retained after the advisory launch review was unavailable: ${detail}`,
  };
}

export class SailPlanner implements GroupPlanner {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly completionWindow: SailCompletionWindow;

  constructor(private readonly config: SailPlannerConfig) {
    if (!config.apiKey) throw new Error('Sail apiKey is required');
    this.baseUrl = (config.baseUrl ?? 'https://api.sailresearch.com/v1').replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.completionWindow = config.completionWindow ?? 'asap';
  }

  async prewarm(session: Session): Promise<void> {
    if (!this.config.researcher) return;
    const locationHint = this.config.locationHint ?? 'San Francisco Bay Area';
    await this.config.emitProgress?.(session.id, 'Preloading current venues and bookable windows…');
    await this.config.researcher.research({
      goal: session.goal,
      query: researchBrief(session, locationHint),
      locationHint,
      participantCount: Math.max(session.participants.length, 4),
    });
    await this.config.emitProgress?.(session.id, 'Live research cached for launch');
  }

  async prepare(session: Session, options: { replanning?: boolean } = {}): Promise<CoordinationPreparation> {
    if (!this.config.researcher) throw new Error('Sail research tool is not configured');
    const history = closeDanglingCalls(await this.config.loadHistory(session.id));
    const input: ConversationItem[] = [
      ...history,
      {
        role: 'user',
        content: `${options.replanning ? 'Revise' : 'Start'} coordination for this authoritative session:\n${JSON.stringify(sessionSnapshot(session, false))}`,
      },
    ];
    const locationHint = this.config.locationHint ?? 'San Francisco Bay Area';
    await this.config.emitProgress?.(session.id, 'Checking live evidence against the final group…');
    const researched = await this.config.researcher.research({
      goal: session.goal,
      query: researchBrief(session, locationHint),
      locationHint,
      participantCount: session.participants.length,
    });
    await this.config.emitProgress?.(
      session.id,
      `${researched.length} sourced options across ${new Set(researched.map((candidate) => candidate.slot)).size} time windows are ready for Sail`,
    );
    const system: ConversationItem = {
      role: 'system',
      content: `You are Badger's long-lived autonomous group coordinator. ${options.replanning ? 'Participants are not being called again. The group changed the goal mid-conversation; research and rank replacement options that respect the availability already collected.' : 'The backend launches all initial calls immediately, in parallel with this research turn, so those calls may already be ringing or underway.'} Evaluate the evidence, rank the strongest sourced options, and review one call-first outreach step for every participant. Do not narrate future call order or claim Badger "will call" someone; the UI must describe the actual live state. Do not propose or commit before hearing each participant's constraints. Failed or unanswered calls automatically fall back to SMS. Return two to four punchy public insights formatted like "Evidence · …", "Tradeoff · …", and "Plan · …". The Plan insight must describe the actual current execution state. All insight/reason fields are displayed publicly: stay group-level and never include a participant's private answer, constraint, veto, or flexibility score.`,
    };
    const launchInput: ConversationItem[] = [...input, {
      role: 'user',
      content: `The sourced research tool returned these authoritative options:\n${JSON.stringify(researched)}`,
    }];
    let launchOutput: ConversationItem[] = [];
    try {
      launchOutput = await this.requestTool(
        session,
        [system, ...launchInput],
        {
        type: 'function',
        name: 'launch_coordination',
        description: 'Select sourced options and define the ordered initial outreach plan.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['candidateIds', 'outreach', 'insights', 'reason'],
          properties: {
            candidateIds: {
              type: 'array',
              minItems: 2,
              uniqueItems: true,
              items: { type: 'string', enum: researched.map((candidate) => candidate.id) },
            },
            outreach: {
              type: 'object',
              additionalProperties: false,
              required: session.participants.map((participant) => participant.id),
              properties: Object.fromEntries(session.participants.map((participant) => [participant.id, {
                type: 'object',
                additionalProperties: false,
                required: ['channel', 'delaySeconds', 'callAfterSeconds', 'message', 'reason'],
                properties: {
                  channel: {
                    type: 'string',
                    enum: ['CALL_ONLY'],
                    description: 'Initial outreach is always a call; Badger handles SMS fallback after a failed call.',
                  },
                  delaySeconds: { type: 'number' },
                  callAfterSeconds: { type: 'number' },
                  message: { type: 'string' },
                  reason: { type: 'string' },
                },
              }])),
            },
            insights: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string' },
              description: 'Public-safe evidence, tradeoff, and plan summaries for the live UI.',
            },
            reason: { type: 'string', description: 'One concise public-safe summary of the outreach strategy.' },
          },
        },
        },
        'launch_coordination',
      );
      const launchCall = launchOutput.find((item) => item.type === 'function_call' && item.name === 'launch_coordination');
      if (typeof launchCall?.arguments !== 'string' || typeof launchCall.call_id !== 'string') {
        throw new Error('Sail did not call launch_coordination');
      }
      const preparation = parsePreparation(session, researched, JSON.parse(launchCall.arguments) as unknown);
      for (const insight of preparation.insights.filter((item) => !item.startsWith('Plan ·'))) {
        await this.config.emitReasoning?.(session.id, insight);
      }
      await this.config.emitReasoning?.(
        session.id,
        options.replanning
          ? 'Plan · Badger is preserving the replies already collected while researching the revised plan.'
          : 'Plan · Calls are already underway while Sail prepares the option and conflict strategy.',
      );
      await this.config.saveHistory(session.id, [...launchInput, ...launchOutput, {
        type: 'function_call_output',
        call_id: launchCall.call_id,
        output: JSON.stringify({ ok: true, detail: 'Research accepted; outreach review captured while calls are underway' }),
      }]);
      return preparation;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const fallback = researchFallbackPreparation(session, researched, detail, options.replanning);
      for (const insight of fallback.insights) await this.config.emitReasoning?.(session.id, insight);
      const launchCall = launchOutput.find((item) => item.type === 'function_call' && typeof item.call_id === 'string');
      await this.config.saveHistory(session.id, [
        ...launchInput,
        ...launchOutput,
        ...(typeof launchCall?.call_id === 'string' ? [{
          type: 'function_call_output',
          call_id: launchCall.call_id,
          output: JSON.stringify({ ok: false, detail: `Used authoritative research fallback: ${detail}` }),
        }] : [{
          role: 'assistant',
          content: `The launch review was unavailable. The backend retained all authoritative sourced options and calls continued. Detail: ${detail}`,
        }]),
      ]);
      return fallback;
    }
  }

  private async appendContext(sessionId: string, items: ConversationItem[]): Promise<void> {
    if (this.config.appendHistory) {
      await this.config.appendHistory(sessionId, items);
      return;
    }
    const history = closeDanglingCalls(await this.config.loadHistory(sessionId));
    await this.config.saveHistory(sessionId, [...history, ...items]);
  }

  async observeMessage(session: Session, participant: Participant, body: string): Promise<void> {
    await this.appendContext(session.id, [{
      role: 'user',
      content: `Inbound participant text captured for the long-lived coordination context.\nParticipant: ${JSON.stringify({ id: participant.id, name: participant.name })}\nMessage: ${JSON.stringify(body)}`,
    }]);
  }

  async observeInboundDecision(
    sessionId: string,
    participant: Participant,
    decision: InboundMessageDecision,
  ): Promise<void> {
    await this.appendContext(sessionId, [{
      role: 'assistant',
      content: `The low-latency reply interpreter selected this validated next step for ${participant.name}: ${JSON.stringify({
        action: decision.action,
        channel: decision.channel,
        message: decision.message,
        preferences: decision.preferences,
        updatedGoal: decision.updatedGoal,
      })}`,
    }]);
  }

  async interpretMessage(
    session: Session,
    participant: Participant,
    body: string,
  ): Promise<InboundMessageDecision> {
    const history = closeDanglingCalls(await this.config.loadHistory(session.id));
    const hasActiveOption =
      Boolean(session.selectedCandidateId) && (
        (session.status === 'PROPOSING' && participant.status === 'PROPOSED') ||
        (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP')
      );
    const allowedActions: InboundMessageDecision['action'][] = hasActiveOption
      ? ['RECORD_PREFERENCES', 'ACCEPT_ACTIVE_OPTION', 'REJECT_ACTIVE_OPTION', 'ASK_FOLLOWUP', 'RESPOND_WITH_CONTEXT', 'CHANGE_PLAN']
      : ['RECORD_PREFERENCES', 'ASK_FOLLOWUP', 'RESPOND_WITH_CONTEXT', 'CHANGE_PLAN'];
    const turn: ConversationItem = {
      role: 'user',
      content: `A participant sent a text message. Decide the next coordination action using the full history and current authoritative state.\nActive option for this participant: ${hasActiveOption ? 'yes' : 'no'}\nParticipant: ${JSON.stringify({ id: participant.id, name: participant.name, status: participant.status, preferences: participant.preferences })}\nMessage: ${JSON.stringify(body)}\nSession: ${JSON.stringify(sessionSnapshot(session))}`,
    };
    const input: ConversationItem[] = [...history, turn];
    const system: ConversationItem = {
      role: 'system',
      content: `You are Badger's long-lived group coordinator interpreting one inbound text. STOP/opt-out is handled before you are called. Be conversational, not a scheduling form. Choose exactly one action. RESPOND_WITH_CONTEXT answers questions about the goal, researched options, current proposal, tradeoffs, or what Badger is doing without changing state; use only supplied evidence and never reveal another participant's private answer. CHANGE_PLAN applies when someone materially changes the activity, venue, city, or overall goal; updatedGoal must be a complete replacement goal that preserves unchanged timing/location context. A different day or time is a counterproposal, not CHANGE_PLAN. RECORD_PREFERENCES stores scheduling input. ACCEPT_ACTIVE_OPTION or REJECT_ACTIVE_OPTION applies to the selected option. ASK_FOLLOWUP asks only when a necessary detail is genuinely missing. For conversational actions, write the exact concise response. The preference fields must reflect only what the participant actually said plus saved preferences. The reason is public, so keep it group-level and private-safe.`,
    };
    const output = await this.requestTool(
      session,
      [system, ...input],
      {
        type: 'function',
        name: 'interpret_inbound_message',
        description: 'Interpret a participant text and choose the next coordination action and channel.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: [
            'action', 'channel', 'message', 'reason', 'availability', 'hardVetoes',
            'softPreferences', 'flexibility', 'summary', 'updatedGoal',
          ],
          properties: {
            action: {
              type: 'string',
              enum: allowedActions,
            },
            channel: { type: 'string', enum: ['NONE', 'SMS', 'CALL'] },
            message: { type: 'string' },
            reason: { type: 'string', description: 'A concise public-safe group-level explanation.' },
            availability: { type: 'array', items: { type: 'string' } },
            hardVetoes: { type: 'array', items: { type: 'string' } },
            softPreferences: { type: 'array', items: { type: 'string' } },
            flexibility: { type: 'number' },
            summary: { type: 'string' },
            updatedGoal: { type: 'string' },
          },
        },
      },
      'interpret_inbound_message',
    );
    const call = output.find((item) => item.type === 'function_call' && item.name === 'interpret_inbound_message');
    if (typeof call?.arguments !== 'string' || typeof call.call_id !== 'string') {
      throw new Error('Sail did not call interpret_inbound_message');
    }
    const decision = parseInboundDecision(JSON.parse(call.arguments) as unknown);
    const publicDecision = decision.action === 'RECORD_PREFERENCES'
      ? 'Sail incorporated a new availability update.'
      : decision.action === 'ACCEPT_ACTIVE_OPTION'
        ? 'Sail recognized agreement with the active option.'
      : decision.action === 'REJECT_ACTIVE_OPTION'
          ? 'Sail reopened coordination around the active option.'
          : decision.action === 'RESPOND_WITH_CONTEXT'
            ? 'Sail answered a participant question without changing the plan.'
            : decision.action === 'CHANGE_PLAN'
              ? 'Sail recognized a material change to the group plan.'
          : `Sail chose a ${decision.channel === 'CALL' ? 'callback' : 'text follow-up'} before changing the plan.`;
    await this.config.emitReasoning?.(session.id, `Decision · ${publicDecision}`);
    // Another participant may have completed a Sail turn while this request
    // was in flight. Append to the latest persisted history instead of
    // overwriting that concurrent result with our older snapshot.
    const latestHistory = closeDanglingCalls(await this.config.loadHistory(session.id));
    await this.config.saveHistory(session.id, [...latestHistory, turn, ...output, {
      type: 'function_call_output',
      call_id: call.call_id,
      output: JSON.stringify({ ok: true, detail: 'Inbound decision accepted for backend validation' }),
    }]);
    return decision;
  }

  async recommend(session: Session, options: { emitReasoning?: boolean } = {}): Promise<PlannerDecision> {
    const history = closeDanglingCalls(await this.config.loadHistory(session.id));
    const snapshot = sessionSnapshot(session);
    const input: ConversationItem[] = [
      ...history,
      { role: 'user', content: `Current authoritative coordination state:\n${JSON.stringify(snapshot)}` },
    ];
    const requestInput: ConversationItem[] = [{
      role: 'system',
      content: `You are Badger's long-lived autonomous group coordinator. Use the original research, all prior outreach, current state, prior tool calls, and their results. Choose the best safe candidate and, when there is a conflict, the best participant to negotiate with. For flexibility requests, choose SMS or a targeted CALL and a delay from 0-120 seconds. Proposals and commitments must use SMS. You may change the provisional candidate and flexibility target when the evidence supports it. Never violate a hard veto or reveal private answers. Write concise messages that tell recipients how to respond. The reason field is displayed in the shared UI: make it one concise, group-level decision summary without any participant's private answer, constraint, veto, or flexibility score.`,
    }, ...input];
    const requestBody: ConversationItem = {
        model: this.config.model ?? 'openai/gpt-oss-120b',
        reasoning: { effort: this.config.reasoningEffort ?? 'low', generate_summary: 'concise' },
        input: requestInput,
        tools: [{
          type: 'function',
          name: 'coordinate_group',
          description: 'Choose and phrase the next validated group-coordination action.',
          strict: true,
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'candidateId', 'participantId', 'message', 'reason', 'channel', 'delaySeconds'],
            properties: {
              action: { type: 'string', enum: ['REQUEST_FLEXIBILITY', 'PROPOSE_PLAN', 'COMMIT_PLAN'] },
              candidateId: { type: 'string' },
              participantId: { type: ['string', 'null'] },
              message: { type: 'string' },
              reason: { type: 'string', description: 'One concise public-safe summary explaining the decision.' },
              channel: { type: 'string', enum: ['SMS', 'CALL'] },
              delaySeconds: { type: 'number' },
            },
          },
        }],
        tool_choice: { type: 'function', name: 'coordinate_group' },
        max_output_tokens: 400,
        prompt_cache_key: `badger:${session.id}`,
        metadata: { completion_window: this.completionWindow, badger_session_id: session.id },
        background: true,
      };
    const output = await this.runResponse(
      session,
      requestBody,
      createHash('sha256').update(JSON.stringify(requestBody)).digest('hex'),
      'planner',
    );
    const call = output.find((item) => item.type === 'function_call' && item.name === 'coordinate_group');
    if (typeof call?.arguments !== 'string' || typeof call.call_id !== 'string') {
      throw new Error('Sail response did not call coordinate_group');
    }
    const decision = validateDecision(session, parseDecision(JSON.parse(call.arguments) as unknown));
    if (options.emitReasoning !== false) {
      await this.config.emitReasoning?.(session.id, `Decision · ${decision.reason}`);
    }
    await this.config.saveHistory(session.id, [...input, ...output]);
    return decision;
  }

  private async requestTool(
    session: Session,
    input: ConversationItem[],
    tool: ConversationItem,
    toolName: string,
  ): Promise<ConversationItem[]> {
    const requestBody: ConversationItem = {
      model: this.config.model ?? 'openai/gpt-oss-120b',
      reasoning: { effort: this.config.reasoningEffort ?? 'low', generate_summary: 'concise' },
      input,
      tools: [tool],
      tool_choice: { type: 'function', name: toolName },
      max_output_tokens: 800,
      prompt_cache_key: `badger:${session.id}`,
      metadata: { completion_window: this.completionWindow, badger_session_id: session.id },
      background: true,
    };
    return this.runResponse(
      session,
      requestBody,
      createHash('sha256').update(`${toolName}:${JSON.stringify(requestBody)}`).digest('hex'),
      toolName,
    );
  }

  private async runResponse(
    session: Session,
    requestBody: ConversationItem,
    idempotencyKey: string,
    operation: string,
  ): Promise<ConversationItem[]> {
    const timeoutMs = this.config.requestTimeoutMs ?? 45_000;
    const deadline = Date.now() + timeoutMs;
    const request = async () => this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)),
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(requestBody),
    });
    let response: Response;
    try {
      response = await request();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      // Idempotency makes this safe: a timed-out submission resumes the same
      // inference reservation instead of starting and charging another one.
      response = await request();
    }
    let raw = await response.text();
    if (!response.ok) throw new Error(`Sail ${operation} failed (${response.status}): ${raw || response.statusText}`);
    let body = JSON.parse(raw) as { id?: string; status?: string; output?: ConversationItem[]; error?: unknown };
    if (body.status === 'queued' || body.status === 'in_progress') {
      if (!body.id) throw new Error(`Sail ${operation} background response omitted id`);
      const responseId = body.id;
      await this.config.emitProgress?.(session.id, 'Sail accepted the orchestration job');
      while (body.status === 'queued' || body.status === 'in_progress') {
        if (Date.now() >= deadline) throw new Error(`Sail ${operation} exceeded ${timeoutMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, 750));
        response = await this.fetchImpl(`${this.baseUrl}/responses/${encodeURIComponent(responseId)}`, {
          signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))),
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
        });
        raw = await response.text();
        if (!response.ok) throw new Error(`Sail ${operation} poll failed (${response.status}): ${raw || response.statusText}`);
        body = JSON.parse(raw) as typeof body;
      }
    }
    if (body.status === 'failed' || body.status === 'cancelled') {
      throw new Error(`Sail ${operation} ended with ${body.status}: ${JSON.stringify(body.error ?? {})}`);
    }
    return body.output ?? [];
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
