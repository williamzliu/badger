import type { BadgerEvent, CallMetadata, Participant, ParticipantPreferences, Session } from '../shared/types.js';
import { CartesiaClient, requestBadgerCall } from '../voice/cartesia.js';
import {
  MESSAGE_COPY,
  SpectrumMessagingClient,
  displayCandidateTime,
  isNaturalConfirmation,
  sendBadgerMessage,
  type InboundMessageIntent,
} from '../voice/spectrum.js';
import { CartesiaWebhookProcessor, type WebhookProcessResult } from '../voice/webhooks.js';
import { EventLog } from './events.js';
import { OpenAIFastInboundPlanner, type InboundMessagePlanner } from './fast-inbound.js';
import { OpenAIOptionResearcher } from './research.js';
import {
  type CoordinationPreparation,
  type GroupPlanner,
  type InboundMessageDecision,
  type OutreachStep,
  type PlannerDecision,
  SailPlanner,
  type SailCompletionWindow,
} from './sail.js';
import { SessionStore } from './sessions.js';
import { BadgerWorkflow, matchesSlot } from './state-machine.js';
import { inferCounterproposalFromText, inferPreferencesFromText } from './text-replies.js';

export interface Communications {
  start(): Promise<void>;
  stop(): Promise<void>;
  prewarm?(session: Session): Promise<void>;
  contact(session: Session): Promise<void>;
  afterPreferences(session: Session, previousStatus: Session['status']): Promise<void>;
  afterConfirmation(session: Session, previousStatus: Session['status']): Promise<void>;
  handleCartesiaWebhook(secret: string | undefined, body: unknown): Promise<WebhookProcessResult>;
}

type LiveCommunicationsConfig = {
  sessions: SessionStore;
  events: EventLog;
  workflow: BadgerWorkflow;
  cartesia: CartesiaClient;
  spectrum: SpectrumMessagingClient;
  cartesiaWebhookSecret: string;
  planner: GroupPlanner;
  inboundPlanner?: InboundMessagePlanner;
  callDelayMs?: number;
  callStaggerMs?: number;
};

function callMetadata(session: Session, participant: Participant): CallMetadata {
  return {
    sessionId: session.id,
    participantId: participant.id,
    participantName: participant.name,
    hostName: session.hostName,
    goal: session.goal,
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function clockMinutes(value: string): number | undefined {
  const match = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  if (match[3]!.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (match[3]!.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return hour * 60 + Number(match[2] ?? 0);
}

function relativeCandidate(session: Session, body: string) {
  const active = session.candidates.find((candidate) => candidate.id === session.selectedCandidateId);
  const activeMinutes = active ? clockMinutes(active.time) : undefined;
  if (!active || activeMinutes === undefined) return undefined;
  const wantsLater = /\b(?:later|afterwards?|after that|later in the day)\b/i.test(body);
  const wantsEarlier = /\b(?:earlier|before that|earlier in the day)\b/i.test(body);
  if (!wantsLater && !wantsEarlier) return undefined;
  const activeDay = active.slot.split('_')[0];
  return session.candidates
    .filter((candidate) => candidate.id !== active.id && candidate.slot.startsWith(`${activeDay}_`))
    .map((candidate) => ({ candidate, minutes: clockMinutes(candidate.time) }))
    .filter((item): item is { candidate: Session['candidates'][number]; minutes: number } =>
      item.minutes !== undefined && (wantsLater ? item.minutes > activeMinutes : item.minutes < activeMinutes))
    .sort((a, b) => {
      const sameVenueA = a.candidate.theater === active.theater ? 0 : 1;
      const sameVenueB = b.candidate.theater === active.theater ? 0 : 1;
      return sameVenueA - sameVenueB || Math.abs(a.minutes - activeMinutes) - Math.abs(b.minutes - activeMinutes);
    })[0]?.candidate;
}

function preferencesForAlternative(participant: Participant, candidate: Session['candidates'][number], body: string) {
  return {
    availability: [candidate.slot],
    hardVetoes: (participant.preferences?.hardVetoes ?? []).filter((veto) => !matchesSlot(veto, candidate.slot)),
    preferences: participant.preferences?.preferences ?? [],
    flexibility: participant.preferences?.flexibility ?? 0.7,
    summary: `${participant.preferences?.summary ?? ''} Follow-up: ${body.trim()}`.trim(),
  };
}

function concreteAlternativeFromMessage(session: Session, message: string) {
  const minutes = clockMinutes(message);
  if (minutes === undefined) return undefined;
  const normalized = message.toLowerCase();
  const namedDay = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .find((day) => normalized.includes(day));
  const matches = session.candidates.filter((candidate) =>
    candidate.id !== session.selectedCandidateId &&
    clockMinutes(candidate.time) === minutes &&
    (!namedDay || candidate.slot.startsWith(`${namedDay}_`)));
  if (!matches.length) return undefined;
  return [...matches].sort((a, b) => {
    const aNamed = normalized.includes(a.theater.toLowerCase()) ? 0 : 1;
    const bNamed = normalized.includes(b.theater.toLowerCase()) ? 0 : 1;
    return aNamed - bNamed;
  })[0];
}

export function groundInboundDecision(
  session: Session,
  participant: Participant,
  body: string,
  decision: InboundMessageDecision,
): InboundMessageDecision {
  const hasActive = Boolean(session.selectedCandidateId) && (
    (session.status === 'PROPOSING' && participant.status === 'PROPOSED') ||
    (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP')
  );
  if (!hasActive || decision.action !== 'ASK_FOLLOWUP') return decision;
  const alternative = concreteAlternativeFromMessage(session, decision.message);
  if (!alternative) return decision;
  return {
    action: 'REJECT_ACTIVE_OPTION',
    channel: 'NONE',
    message: '',
    reason: `The follow-up identified ${displayCandidateTime(alternative.time)} as a concrete alternative.`,
    preferences: preferencesForAlternative(participant, alternative, body),
  };
}

export function instantInboundDecision(
  session: Session,
  participant: Participant,
  body: string,
): InboundMessageDecision | undefined {
  const activeCandidate = session.candidates.find((candidate) => candidate.id === session.selectedCandidateId);
  const isActiveParticipant = Boolean(activeCandidate) && (
    (session.status === 'PROPOSING' && participant.status === 'PROPOSED') ||
    (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP')
  );
  const inferred = body.trim() ? inferPreferencesFromText(session, participant, body) : undefined;
  const explicitlyNegative = /^(?:no|nope|nah)\b|\b(?:cannot|can't|cant|unavailable|not available|doesn't work|does not work|won't work)\b/i
    .test(body.trim());
  const relative = isActiveParticipant ? relativeCandidate(session, body) : undefined;
  if (relative) {
    return {
      action: 'REJECT_ACTIVE_OPTION',
      channel: 'NONE',
      message: '',
      reason: `A nearby ${relative.slot.replaceAll('_', ' ')} option matches the requested change.`,
      preferences: preferencesForAlternative(participant, relative, body),
    };
  }
  if (isActiveParticipant && isNaturalConfirmation(body)) {
    return {
      action: 'ACCEPT_ACTIVE_OPTION',
      channel: 'NONE',
      message: '',
      reason: 'The participant confirmed the active option.',
      preferences: inferred ?? participant.preferences ?? {
        availability: [], hardVetoes: [], preferences: [], flexibility: 0.5, summary: body.trim(),
      },
    };
  }
  if (isActiveParticipant && explicitlyNegative) {
    return {
      action: 'REJECT_ACTIVE_OPTION',
      channel: 'NONE',
      message: '',
      reason: 'The participant rejected the active option.',
      preferences: inferCounterproposalFromText(session, participant, body) ?? participant.preferences ?? {
        availability: [], hardVetoes: [], preferences: [], flexibility: 0.5, summary: body.trim(),
      },
    };
  }
  const agreesWithActive = Boolean(
    isActiveParticipant && activeCandidate && inferred &&
    /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|morning|afternoon|evening|night)\b/i.test(body) &&
    inferred.availability.some((slot) => matchesSlot(slot, activeCandidate.slot)) &&
    !inferred.hardVetoes.some((slot) => matchesSlot(slot, activeCandidate.slot)),
  );
  if (agreesWithActive) {
    return {
      action: 'ACCEPT_ACTIVE_OPTION',
      channel: 'NONE',
      message: '',
      reason: 'The reply directly matches the active option.',
      preferences: inferred!,
    };
  }
  if (isActiveParticipant && activeCandidate && inferred) {
    const includesActiveWindow = inferred.availability.some((slot) => matchesSlot(slot, activeCandidate.slot)) &&
      !inferred.hardVetoes.some((slot) => matchesSlot(slot, activeCandidate.slot));
    if (includesActiveWindow) {
      return {
        action: 'ASK_FOLLOWUP',
        channel: 'SMS',
        message: `I can work with that. Keep ${displayCandidateTime(activeCandidate.time)} at ${activeCandidate.theater}, or should I look for another time?`,
        reason: 'The participant supplied a broad compatible window; Badger narrowed it to the current option.',
        preferences: inferred,
      };
    }
    const counterproposal = inferCounterproposalFromText(session, participant, body) ?? inferred;
    return {
      action: 'REJECT_ACTIVE_OPTION',
      channel: 'NONE',
      message: '',
      reason: 'The participant offered a different workable window, so Badger reopened matching.',
      preferences: counterproposal,
    };
  }
  const canRecordExplicitWindow = Boolean(inferred) && (
    session.status === 'COLLECTING' ||
    (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP' && !activeCandidate)
  );
  if (!canRecordExplicitWindow) return undefined;
  return {
    action: 'RECORD_PREFERENCES',
    channel: 'NONE',
    message: '',
    reason: 'The reply contains a directly usable availability window.',
    preferences: inferred!,
  };
}

export class LiveCommunications implements Communications {
  private readonly abort = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private readonly preparing = new Set<string>();
  private readonly reviewQueued = new Set<string>();
  private readonly reviewing = new Set<string>();
  private readonly planChanging = new Set<string>();
  private readonly activeCalls = new Map<string, number>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly webhook: CartesiaWebhookProcessor;
  private started = false;

  constructor(private readonly config: LiveCommunicationsConfig) {
    this.webhook = new CartesiaWebhookProcessor({
      webhookSecret: config.cartesiaWebhookSecret,
      lookupMetadata: (callId) => config.sessions.lookupCall(callId),
      isDuplicateDelivery: (deliveryId) => config.sessions.receiveWebhook('cartesia', deliveryId),
      releaseDelivery: (deliveryId) => config.sessions.releaseWebhook('cartesia', deliveryId),
      emit: (event) => this.onCartesiaEvent(event),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.background(this.config.spectrum.listenForReplies({
      signal: this.abort.signal,
      resolveContext: (from) => {
        const match = this.config.sessions.findActiveParticipantByPhone(from);
        return match ? {
          sessionId: match.session.id,
          participantId: match.participant.id,
          participantName: match.participant.name,
        } : undefined;
      },
      emit: (event) => {
        // Sail interpretation can take several seconds. Do not block the
        // provider's inbound stream or unrelated participants behind it.
        this.background(this.onSpectrumEvent(event));
      },
    }));
    this.background(this.reconciliationLoop());
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.config.spectrum.stop();
    await Promise.allSettled([...this.tasks]);
  }

  async prewarm(session: Session): Promise<void> {
    await this.config.planner.prewarm?.(session);
  }

  async contact(session: Session): Promise<void> {
    // Start the real calls immediately. Research and long-horizon Sail
    // orchestration are useful context, but neither belongs on the ringing
    // critical path.
    this.background(this.callParticipants(session.id, 0));
    if (this.config.planner.prepare) {
      this.preparing.add(session.id);
      try {
        this.config.events.append(session.id, 'research.started', 'Sail is researching real options…');
        const preparation = await this.config.planner.prepare(session);
        this.config.sessions.replaceCandidates(session.id, preparation.candidates);
        this.config.events.append(session.id, 'research.completed', `Sail found ${preparation.candidates.length} sourced options`, {
          reason: preparation.reason,
          sources: preparation.research.map((candidate) => ({
            candidateId: candidate.id,
            sourceUrl: candidate.sourceUrl,
            evidence: candidate.evidence,
          })),
        });
        this.config.events.append(session.id, 'outreach.planned', 'Sail reviewed the call-first outreach strategy', {
          steps: preparation.outreach.map(({ message: _message, ...step }) => step),
        });
      } catch (error) {
        this.integrationFailure(session, undefined, 'Sail research and outreach planning', error);
      } finally {
        this.preparing.delete(session.id);
        this.kickPlannerReview(session.id);
      }
    }
  }

  async afterPreferences(session: Session, previousStatus: Session['status']): Promise<void> {
    const planRequester = session.participants.find((participant) => participant.preferences?.planRequest);
    if (planRequester?.preferences?.planRequest) {
      this.background(this.applyPlanChange(
        session.id,
        planRequester.id,
        planRequester.preferences.planRequest,
      ));
      return;
    }
    if (session.status === 'RESOLVING') {
      const provisionalTarget = session.participants.find((participant) => participant.status === 'NEEDS_FOLLOWUP');
      const provisionalCandidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
      if (!provisionalTarget) return;
      const question = provisionalCandidate
        ? `Would ${displayCandidateTime(provisionalCandidate.time)} at ${provisionalCandidate.theater} work for you? If not, what nearby time could?`
        : 'None of the current options fit everyone. What other day or time could you make work?';
      // Never interrupt one conversation with another outreach attempt. The
      // completed-call recovery will send this same question after hangup.
      if (this.hasActiveCall(`${session.id}:${provisionalTarget.id}`)) return;
      const execute = async () => {
        const fresh = this.config.sessions.get(session.id);
        const freshTarget = fresh?.participants.find((participant) => participant.id === provisionalTarget.id);
        if (!fresh || !freshTarget || fresh.status !== 'RESOLVING' || freshTarget.status !== 'NEEDS_FOLLOWUP') return;
        const key = `flex:${session.id}:${provisionalCandidate?.id ?? 'broaden'}:${provisionalTarget.id}`;
        if (this.config.events.list(session.id).some((event) => event.id === key)) return;
        await this.safeSend(
          fresh,
          freshTarget,
          `${question} Reply here, or reply STOP to opt out.`,
          key,
        );
      };
      this.background(execute());
      this.schedulePlannerReview(session.id);
      return;
    }
    if (session.status === 'PROPOSING') {
      const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
      if (!candidate) return;
      const message = MESSAGE_COPY.proposal(candidate.time, candidate.theater);
      const sends = await Promise.all(session.participants
        .filter((participant) => participant.required && participant.status === 'PROPOSED')
        .map((participant) => this.safeSend(session, participant, message, `proposal:${session.id}:${candidate.id}:${participant.id}`)));
      void sends;
      this.schedulePlannerReview(session.id);
    }
  }

  async afterConfirmation(session: Session, previousStatus: Session['status']): Promise<void> {
    if (previousStatus === 'COMMITTED' || session.status !== 'COMMITTED') return;
    const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
    if (!candidate) return;
    const required = session.participants.filter((participant) => participant.required);
    const fallback = MESSAGE_COPY.commitment(candidate.time, candidate.theater, required.length, required.length);
    // Opt-out is a hard stop: declined participants get no further messages.
    const sends = await Promise.all(session.participants
      .filter((participant) => participant.status !== 'DECLINED')
      .map((participant) =>
        this.safeSend(session, participant, fallback, `commit:${session.id}:${candidate.id}:${participant.id}`)));
    void sends;
    this.schedulePlannerReview(session.id);
  }

  handleCartesiaWebhook(secret: string | undefined, body: unknown): Promise<WebhookProcessResult> {
    return this.webhook.process(secret, body);
  }

  private background(task: Promise<void>): void {
    const guarded = task.catch((error: unknown) => {
      if (!this.abort.signal.aborted) console.error('[badger.integration]', error);
    }).finally(() => this.tasks.delete(guarded));
    this.tasks.add(guarded);
  }

  private schedulePlannerReview(sessionId: string): void {
    this.reviewQueued.add(sessionId);
    this.kickPlannerReview(sessionId);
  }

  private kickPlannerReview(sessionId: string): void {
    if (this.preparing.has(sessionId) || this.reviewing.has(sessionId) || !this.reviewQueued.has(sessionId)) return;
    this.reviewing.add(sessionId);
    this.background(this.drainPlannerReviews(sessionId));
  }

  private plannerReviewVersion(session: Session): string {
    const inboundIds = this.config.events.list(session.id)
      .filter((event) => event.type === 'message.received' || event.type === 'preferences.received')
      .map((event) => event.id);
    return JSON.stringify({
      status: session.status,
      selectedCandidateId: session.selectedCandidateId,
      participants: session.participants.map((participant) => ({
        id: participant.id,
        status: participant.status,
        preferences: participant.preferences,
      })),
      inboundIds,
    });
  }

  private async drainPlannerReviews(sessionId: string): Promise<void> {
    try {
      while (this.reviewQueued.delete(sessionId)) {
        const session = this.config.sessions.get(sessionId);
        if (!session || !['RESOLVING', 'PROPOSING', 'COMMITTED'].includes(session.status)) continue;
        try {
          const reviewVersion = this.plannerReviewVersion(session);
          const decision = await this.config.planner.recommend(session, { emitReasoning: false });
          const fresh = this.config.sessions.get(sessionId);
          const stale = !fresh || this.plannerReviewVersion(fresh) !== reviewVersion;
          await this.config.planner.recordOutcome(sessionId, decision, {
            ok: !stale,
            detail: stale
              ? 'Review became stale because a participant replied; recompute from the latest state'
              : 'Reviewed asynchronously; the low-latency path already executed the current safe action',
          });
          if (stale) {
            this.reviewQueued.add(sessionId);
            continue;
          }
          this.config.events.append(sessionId, 'sail.reasoning', `Decision · ${decision.reason}`);
          this.config.events.append(sessionId, 'planner.reviewed', 'Sail reviewed the latest coordination state', {
            action: decision.action,
            candidateId: decision.candidateId,
            participantId: decision.participantId,
          });
        } catch (error) {
          // Advisory work must never turn a successful call or text into a
          // visible failure. It will be retried on the next state change.
          console.warn('[badger.sail.review]', error);
        }
      }
    } finally {
      this.reviewing.delete(sessionId);
      this.kickPlannerReview(sessionId);
    }
  }

  private async executeOutreachPlan(sessionId: string, preparation: CoordinationPreparation): Promise<void> {
    await Promise.all(preparation.outreach.map((step) => this.executeOutreachStep(sessionId, step)));
  }

  private async executeOutreachStep(sessionId: string, step: OutreachStep): Promise<void> {
    await delay(step.delaySeconds * 1_000, this.abort.signal);
    let session = this.config.sessions.get(sessionId);
    let participant = session?.participants.find((item) => item.id === step.participantId);
    if (!session || !participant || this.abort.signal.aborted || ['COMMITTED', 'CANCELLED'].includes(session.status)) return;
    if (step.channel !== 'CALL_ONLY') {
      const message = /\bstop\b/i.test(step.message) ? step.message : `${step.message} Reply STOP to opt out.`;
      await this.safeSend(session, participant, message, `opening:${session.id}:${participant.id}`);
    }
    if (step.channel === 'TEXT_ONLY') return;
    if (step.channel === 'TEXT_THEN_CALL') await delay(step.callAfterSeconds * 1_000, this.abort.signal);
    session = this.config.sessions.get(sessionId);
    participant = session?.participants.find((item) => item.id === step.participantId);
    if (!session || !participant || this.abort.signal.aborted || !['CONTACTING', 'COLLECTING'].includes(session.status)) return;
    if (['RESPONDED', 'DECLINED', 'CONFIRMED', 'PROPOSED'].includes(participant.status)) return;
    await this.placeParticipantCall(session, participant);
  }

  private async placeParticipantCall(
    session: Session,
    participant: Participant,
    options: {
      idempotencyKey?: string;
      purpose?: 'availability' | 'flexibility';
      question?: string;
      fallbackMessage?: string;
    } = {},
  ): Promise<boolean> {
    this.config.workflow.markCalling(session, participant);
    const activeCallKey = `${session.id}:${participant.id}`;
    this.activeCalls.set(activeCallKey, Date.now());
    try {
      const metadata: CallMetadata = {
        ...callMetadata(session, participant),
        ...(options.purpose ? { purpose: options.purpose } : {}),
        ...(options.question ? { question: options.question } : {}),
      };
      const placed = await requestBadgerCall(this.config.cartesia, {
        to: participant.phone,
        metadata,
        idempotencyKey: options.idempotencyKey ?? `call:${session.id}:${participant.id}`,
      }, (event) => { this.config.events.record(event); });
      this.config.sessions.rememberCall(placed.agentCallId, metadata);
      return true;
    } catch (error) {
      this.activeCalls.delete(activeCallKey);
      const fresh = this.config.sessions.get(session.id);
      const freshParticipant = fresh?.participants.find((item) => item.id === participant.id);
      if (fresh && freshParticipant) {
        this.config.workflow.markCallFinished(fresh, freshParticipant, options.purpose === 'flexibility');
        await this.safeSend(
          fresh,
          freshParticipant,
          options.fallbackMessage ?? MESSAGE_COPY.missedCall(),
          `missed:${session.id}:${participant.id}`,
        );
      }
      return false;
    }
  }

  private async callParticipants(sessionId: string, delayMs = this.config.callDelayMs ?? 10_000): Promise<void> {
    await delay(delayMs, this.abort.signal);
    const initial = this.config.sessions.get(sessionId);
    if (!initial || this.abort.signal.aborted) return;
    await Promise.all(initial.participants.map(async (original, index) => {
      await delay(index * (this.config.callStaggerMs ?? 1_000), this.abort.signal);
      const session = this.config.sessions.get(sessionId);
      const participant = session?.participants.find((item) => item.id === original.id);
      // Re-check BOTH statuses at fire time: a decline/STOP inside the call
      // delay cancels the session, and no phone may ring after that.
      if (!session || !participant || this.abort.signal.aborted) return;
      if (!['CONTACTING', 'COLLECTING'].includes(session.status)) return;
      if (participant.status !== 'TEXTED') return;
      await this.placeParticipantCall(session, participant);
    }));
  }

  private async onCartesiaEvent(event: BadgerEvent): Promise<void> {
    if (!this.config.events.record(event)) return;
    const session = this.config.sessions.get(event.sessionId);
    const participant = session?.participants.find((item) => item.id === event.participantId);
    if (!session || !participant) return;
    const callId = typeof event.privateData.callId === 'string' ? event.privateData.callId : undefined;
    const callContext = callId ? this.config.sessions.lookupCall(callId) : undefined;
    const isFlexibilityCall = callContext?.purpose === 'flexibility';
    const activeCallKey = `${session.id}:${participant.id}`;
    if (event.type === 'call.started') {
      this.activeCalls.set(activeCallKey, Date.now());
      this.config.workflow.markInCall(session, participant);
    }
    if (event.type === 'call.completed' || event.type === 'call.failed') {
      this.activeCalls.delete(activeCallKey);
      this.config.workflow.markCallFinished(session, participant, isFlexibilityCall);
    }
    if (event.type === 'call.completed') {
      this.background(this.recoverMissingCallPreferences(session.id, participant.id, event.id, callContext?.question));
    }
    if (event.type === 'call.failed') {
      await this.safeSend(session, participant, MESSAGE_COPY.missedCall(), `missed:${session.id}:${participant.id}`);
    }
    if (event.type === 'preferences.received' && !participant.preferences) {
      const submitted = event.privateData.preferences as ParticipantPreferences | undefined;
      if (!submitted) return;
      // A call can finish after the session has moved on (e.g. an optional
      // participant's result arriving during PROPOSING, or after cancel).
      // recordPreferences would throw — treat a late result as a no-op.
      if (!['COLLECTING', 'RESOLVING'].includes(session.status)) return;
      try {
        const previousStatus = session.status;
        this.config.workflow.recordPreferences(session, participant, submitted);
        const fresh = this.config.sessions.get(session.id);
        if (fresh) await this.afterPreferences(fresh, previousStatus);
      } catch (error) {
        this.integrationFailure(session, participant, 'voice preferences', error);
      }
    }
  }

  private async recoverMissingCallPreferences(
    sessionId: string,
    participantId: string,
    callEventId: string,
    followUpQuestion?: string,
  ): Promise<void> {
    // Preference submission and call-completed webhooks can cross in flight.
    // Give the tool callback a moment to land, then recover only if the answer
    // is genuinely still missing.
    await delay(2_000, this.abort.signal);
    const session = this.config.sessions.get(sessionId);
    const participant = session?.participants.find((item) => item.id === participantId);
    if (!session || !participant) return;
    const needsInitialAnswer = session.status === 'COLLECTING' && !participant.preferences;
    const needsFollowUpAnswer = session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP';
    if (!needsInitialAnswer && !needsFollowUpAnswer) return;
    const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
    const resolvedQuestion = followUpQuestion ?? (candidate
      ? `Would ${displayCandidateTime(candidate.time)} at ${candidate.theater} work for you? If not, what nearby time could?`
      : 'What other day or time could work?');
    const message = needsFollowUpAnswer
      ? `${resolvedQuestion} Reply here, or reply STOP to opt out.`
      : `I didn't capture your availability on the call. What day and time work for ${session.goal}? Reply STOP to opt out.`;
    await this.safeSend(
      session,
      participant,
      message,
      `call-complete-fallback:${session.id}:${participant.id}:${callEventId}`,
    );
  }

  private hasActiveCall(key: string): boolean {
    const startedAt = this.activeCalls.get(key);
    if (startedAt === undefined) return false;
    // A lost Cartesia completion webhook must not suppress recovery forever.
    // Real availability calls should finish well inside this window.
    if (Date.now() - startedAt < 120_000) return true;
    this.activeCalls.delete(key);
    return false;
  }

  private async reconciliationLoop(): Promise<void> {
    await delay(250, this.abort.signal);
    while (!this.abort.signal.aborted) {
      await this.reconcileInterruptedSessions();
      await delay(3_000, this.abort.signal);
    }
  }

  private async reconcileInterruptedSessions(): Promise<void> {
    for (const session of this.config.sessions.listActive()) {
      if (session.status !== 'RESOLVING') continue;
      const events = this.config.events.list(session.id);
      const latestAsk = [...events].reverse().find((event) => event.type === 'flexibility.requested');
      const targetId = session.participants.find((participant) => participant.status === 'NEEDS_FOLLOWUP')?.id ??
        (typeof latestAsk?.privateData.participantId === 'string' ? latestAsk.privateData.participantId : undefined);
      const participant = session.participants.find((item) => item.id === targetId);
      if (!participant) continue;
      if (participant.status !== 'NEEDS_FOLLOWUP') {
        participant.status = 'NEEDS_FOLLOWUP';
        this.config.sessions.updateParticipant(participant);
      }
      if (this.hasActiveCall(`${session.id}:${participant.id}`)) continue;
      const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
      const question = candidate
        ? `Would ${displayCandidateTime(candidate.time)} at ${candidate.theater} work for you? If not, what nearby time could?`
        : 'None of the current options fit everyone. What other day or time could you make work?';
      const key = `flex:${session.id}:${candidate?.id ?? 'broaden'}:${participant.id}`;
      const sentForThisAsk = events.some((event) =>
        event.id === key ||
        event.id.startsWith(`resume:flex:${session.id}:${candidate?.id ?? 'broaden'}:${participant.id}`) ||
        event.id.startsWith(`call-complete-fallback:${session.id}:${participant.id}:`));
      if (sentForThisAsk) continue;
      // Provider failures remain retryable, but a bad credential or temporary
      // outage should not create a tight message loop.
      const lastAttempt = this.recoveryAttempts.get(key) ?? 0;
      if (Date.now() - lastAttempt < 10_000) continue;
      this.recoveryAttempts.set(key, Date.now());
      const sent = await this.safeSend(session, participant, `${question} Reply here, or reply STOP to opt out.`, key);
      if (sent) this.recoveryAttempts.delete(key);
    }
  }

  private async onSpectrumEvent(event: BadgerEvent): Promise<void> {
    if (!this.config.events.record(event)) return;
    const session = this.config.sessions.get(event.sessionId);
    const participant = session?.participants.find((item) => item.id === event.participantId);
    if (!session || !participant) return;
    const intent = event.privateData.intent as InboundMessageIntent | undefined;
    const body = String(event.privateData.body ?? '');
    if (intent === 'opt_out') {
      this.config.workflow.decline(session, participant);
      return;
    }
    if (body.trim()) {
      try {
        await this.config.planner.observeMessage?.(session, participant, body);
      } catch (error) {
        this.integrationFailure(session, participant, 'Sail context update', error);
      }
    }
    // Explicit scheduling language is faster and safer to resolve locally.
    // In particular, a bare "Sunday" in response to a Sunday proposal means
    // yes—it must never reject Sunday and add it to the participant's vetoes.
    const instantDecision = instantInboundDecision(session, participant, body);
    if (instantDecision) {
      await this.config.planner.observeInboundDecision?.(session.id, participant, instantDecision);
      await this.executeInboundDecision(session, participant, instantDecision, event.id, 'Instant path');
      return;
    }
    const inboundPlanner = this.config.inboundPlanner ?? this.config.planner;
    if (body.trim() && inboundPlanner.interpretMessage) {
      try {
        const interpreted = await inboundPlanner.interpretMessage(session, participant, body);
        const decision = groundInboundDecision(session, participant, body, interpreted);
        await this.config.planner.observeInboundDecision?.(session.id, participant, decision);
        const fresh = this.config.sessions.get(session.id);
        const freshParticipant = fresh?.participants.find((item) => item.id === participant.id);
        if (!fresh || !freshParticipant) return;
        await this.executeInboundDecision(fresh, freshParticipant, decision, event.id);
        return;
      } catch (error) {
        // The fast path has a hard deadline. Preserve a deterministic fallback
        // rather than making the participant wait on provider tail latency.
        this.config.events.append(session.id, 'reply.fallback', '', {
          participantId: participant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (intent === 'decline') {
      const rejectsCandidate =
        (session.status === 'PROPOSING' && ['PROPOSED', 'CONFIRMED'].includes(participant.status)) ||
        (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP');
      if (!rejectsCandidate) {
        // Before a concrete proposal, "no" or "can't make it" is not enough
        // information to remove a required person from the whole plan. Their
        // scheduled call may still run; text also gives them a direct path to
        // offer an alternative. STOP remains the unambiguous hard opt-out.
        if (session.status === 'COLLECTING' && !participant.preferences) {
          await this.safeSend(
            session,
            participant,
            "Got it—is that no to a particular time, or are you out entirely? Send another day and time that works. Reply STOP to opt out.",
            `decline-clarify:${session.id}:${participant.id}:${event.id}`,
          );
          return;
        }
        // A bare "no" from someone who already gave availability most likely
        // answers a superseded proposal (e.g. the second of two simultaneous
        // "no" replies after the first already re-planned) — clarify instead
        // of cancelling the whole session. STOP remains a hard exit above.
        if (participant.preferences) {
          await this.safeSend(
            session,
            participant,
            "Can't make that time, or are you out entirely? Reply STOP if you're out.",
            `decline-clarify:${session.id}:${participant.id}:${event.id}`,
          );
          return;
        }
        this.config.workflow.decline(session, participant);
        return;
      }
      const previousStatus = session.status;
      this.config.workflow.rejectCandidate(session, participant);
      const fresh = this.config.sessions.get(session.id);
      if (fresh) await this.afterPreferences(fresh, previousStatus);
      return;
    }
    const confirmsActiveOption =
      intent === 'freeform' &&
      ((session.status === 'PROPOSING' && participant.status === 'PROPOSED') ||
        (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP')) &&
      isNaturalConfirmation(body);
    const hasActiveOption =
      (session.status === 'PROPOSING' && participant.status === 'PROPOSED') ||
      (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP');
    if (intent === 'freeform' && hasActiveOption && !confirmsActiveOption) {
      try {
        const counterproposal = inferCounterproposalFromText(session, participant, body);
        if (!counterproposal) {
          await this.safeSend(
            session,
            participant,
            "What day or time would work instead? I can call if that's easier.",
            `proposal-clarify:${session.id}:${participant.id}:${event.id}`,
          );
          return;
        }
        const previousStatus = session.status;
        this.config.workflow.rejectCandidate(session, participant, counterproposal);
        const fresh = this.config.sessions.get(session.id);
        if (fresh) await this.afterPreferences(fresh, previousStatus);
      } catch (error) {
        this.integrationFailure(session, participant, 'counterproposal interpretation', error);
      }
      return;
    }
    if (intent === 'freeform' && !confirmsActiveOption) {
      const collecting = session.status === 'COLLECTING' && !participant.preferences;
      if (!collecting) return;
      try {
        const preferences = inferPreferencesFromText(session, participant, body);
        if (!preferences) {
          await this.safeSend(
            session,
            participant,
            "What day and time work for you? I can call if that's easier.",
            `clarify:${session.id}:${participant.id}:${event.id}`,
          );
          return;
        }
        const previousStatus = session.status;
        this.config.workflow.recordPreferences(session, participant, preferences);
        const fresh = this.config.sessions.get(session.id);
        if (fresh) await this.afterPreferences(fresh, previousStatus);
      } catch (error) {
        this.integrationFailure(session, participant, 'text reply interpretation', error);
      }
      return;
    }
    if (intent !== 'confirm' && !confirmsActiveOption) return;
    const previousStatus = session.status;
    if (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP') {
      this.config.workflow.acceptFlexibility(session, participant);
      const fresh = this.config.sessions.get(session.id);
      if (fresh) await this.afterPreferences(fresh, previousStatus);
    } else if (session.status === 'PROPOSING' && participant.status === 'PROPOSED') {
      this.config.workflow.confirm(session, participant);
      const fresh = this.config.sessions.get(session.id);
      if (fresh) await this.afterConfirmation(fresh, previousStatus);
    }
  }

  private async executeInboundDecision(
    session: Session,
    participant: Participant,
    decision: InboundMessageDecision,
    inboundEventId: string,
    path = 'Fast path',
  ): Promise<void> {
    this.config.events.append(session.id, 'planner.decision', `${path} chose ${decision.action.toLowerCase().replaceAll('_', ' ')}`, {
      participantId: participant.id,
      action: decision.action,
      channel: decision.channel,
      reason: decision.reason,
    });
    const previousStatus = session.status;
    if (decision.action === 'RESPOND_WITH_CONTEXT') {
      await this.safeSend(
        session,
        participant,
        decision.message,
        `context-reply:${session.id}:${participant.id}:${inboundEventId}`,
      );
      return;
    }
    if (decision.action === 'CHANGE_PLAN') {
      if (!decision.updatedGoal) throw new Error('Sail omitted the revised goal');
      await this.applyPlanChange(
        session.id,
        participant.id,
        decision.updatedGoal,
        decision.message,
        inboundEventId,
      );
      return;
    }
    if (decision.action === 'RECORD_PREFERENCES') {
      if (!['COLLECTING', 'RESOLVING'].includes(session.status)) {
        throw new Error(`Cannot record text preferences while session is ${session.status}`);
      }
      this.config.workflow.recordPreferences(session, participant, decision.preferences);
      const fresh = this.config.sessions.get(session.id);
      if (fresh) await this.afterPreferences(fresh, previousStatus);
      return;
    }
    if (decision.action === 'ACCEPT_ACTIVE_OPTION') {
      if (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP') {
        this.config.workflow.acceptFlexibility(session, participant);
        const fresh = this.config.sessions.get(session.id);
        if (fresh) await this.afterPreferences(fresh, previousStatus);
        return;
      }
      if (session.status === 'PROPOSING' && participant.status === 'PROPOSED') {
        this.config.workflow.confirm(session, participant);
        const fresh = this.config.sessions.get(session.id);
        if (fresh) await this.afterConfirmation(fresh, previousStatus);
        return;
      }
      throw new Error('Sail accepted an option when none was active for this participant');
    }
    if (decision.action === 'REJECT_ACTIVE_OPTION') {
      const active =
        (session.status === 'PROPOSING' && participant.status === 'PROPOSED') ||
        (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP');
      if (!active) throw new Error('Sail rejected an option when none was active for this participant');
      this.config.workflow.rejectCandidate(
        session,
        participant,
        decision.preferences.summary ? decision.preferences : undefined,
      );
      const fresh = this.config.sessions.get(session.id);
      if (fresh) await this.afterPreferences(fresh, previousStatus);
      return;
    }
    if (decision.channel === 'SMS') {
      await this.safeSend(
        session,
        participant,
        decision.message,
        `reply-followup:${session.id}:${participant.id}:${inboundEventId}`,
      );
      return;
    }
    if (decision.channel === 'CALL') {
      await this.placeParticipantCall(session, participant, {
        idempotencyKey: `call:reply-followup:${session.id}:${participant.id}:${inboundEventId}`,
        purpose: 'flexibility',
        question: decision.message,
      });
      return;
    }
    throw new Error('Sail follow-up did not choose SMS or CALL');
  }

  private async applyPlanChange(
    sessionId: string,
    participantId: string,
    revisedGoal: string,
    acknowledgement?: string,
    inboundEventId?: string,
  ): Promise<void> {
    if (this.planChanging.has(sessionId)) return;
    this.planChanging.add(sessionId);
    try {
      let session = this.config.sessions.get(sessionId);
      let participant = session?.participants.find((item) => item.id === participantId);
      if (!session || !participant || ['COMMITTED', 'CANCELLED'].includes(session.status)) return;
      if (acknowledgement) {
        await this.safeSend(
          session,
          participant,
          acknowledgement,
          `plan-change-ack:${session.id}:${participant.id}:${inboundEventId ?? revisedGoal}`,
        );
      }
      if (participant.preferences?.planRequest) {
        const { planRequest: _planRequest, ...preferences } = participant.preferences;
        participant.preferences = preferences;
        this.config.sessions.updateParticipant(participant);
      }
      session = this.config.workflow.changeGoal(session, revisedGoal, participant);
      this.config.events.append(session.id, 'research.started', 'Researching the revised plan…');
      if (this.config.planner.prepare) {
        try {
          const preparation = await this.config.planner.prepare(session, { replanning: true });
          this.config.sessions.replaceCandidates(session.id, preparation.candidates);
          this.config.events.append(session.id, 'research.completed', `Found ${preparation.candidates.length} sourced options for the revised plan`, {
            reason: preparation.reason,
            sources: preparation.research.map((candidate) => ({
              candidateId: candidate.id,
              sourceUrl: candidate.sourceUrl,
              evidence: candidate.evidence,
            })),
          });
        } catch (error) {
          this.integrationFailure(session, participant, 'revised plan research', error);
        }
      }
      const fresh = this.config.sessions.get(session.id);
      if (!fresh || fresh.status !== 'COLLECTING') return;
      this.config.workflow.reevaluate(fresh);
      const evaluated = this.config.sessions.get(session.id);
      if (evaluated) await this.afterPreferences(evaluated, 'COLLECTING');
    } finally {
      this.planChanging.delete(sessionId);
    }
  }

  private send(participant: Participant, body: string, idempotencyKey: string) {
    return sendBadgerMessage(this.config.spectrum, {
      to: participant.phone,
      body,
      sessionId: participant.sessionId,
      participantId: participant.id,
      idempotencyKey,
    }, (event) => { this.config.events.record(event); });
  }

  private async safeSend(session: Session, participant: Participant, body: string, key: string): Promise<boolean> {
    try {
      await this.send(participant, body, key);
      return true;
    } catch (error) {
      this.integrationFailure(session, participant, 'message', error);
      return false;
    }
  }

  private async plannedMessage(
    session: Session,
    fallback: string,
    participant?: Participant,
  ): Promise<{ message: string; decision?: PlannerDecision }> {
    try {
      const decision = await this.config.planner.recommend(session);
      this.config.workflow.applyPlannerDecision(session, decision);
      this.config.events.append(session.id, 'planner.decision', `Sail chose ${decision.action.toLowerCase().replaceAll('_', ' ')}`, {
        ...(participant ? { participantId: participant.id } : {}),
        action: decision.action,
        candidateId: decision.candidateId,
        reason: decision.reason,
      });
      return { message: decision.message, decision };
    } catch (error) {
      this.integrationFailure(session, participant, 'Sail coordination', error);
      return { message: fallback };
    }
  }

  private async recordPlannerOutcome(
    session: Session,
    decision: PlannerDecision | undefined,
    ok: boolean,
    detail: string,
  ): Promise<void> {
    if (!decision) return;
    try {
      await this.config.planner.recordOutcome(session.id, decision, { ok, detail });
      this.config.events.append(session.id, 'planner.outcome', 'Sail action executed', {
        action: decision.action,
        ok,
      });
    } catch (error) {
      this.integrationFailure(session, undefined, 'Sail history persistence', error);
    }
  }

  private integrationFailure(session: Session, participant: Participant | undefined, operation: string, error: unknown): void {
    this.config.events.append(session.id, 'integration.failed', `${operation} failed`, {
      ...(participant ? { participantId: participant.id } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when BADGER_LIVE_MODE=true`);
  return value;
}

function sailCompletionWindow(value: string | undefined): SailCompletionWindow {
  const window = value?.trim() || 'asap';
  if (!['asap', 'priority', 'standard', 'flex'].includes(window)) {
    throw new Error('SAIL_COMPLETION_WINDOW must be asap, priority, standard, or flex');
  }
  return window as SailCompletionWindow;
}

export function createConfiguredCommunications(input: {
  sessions: SessionStore;
  events: EventLog;
  workflow: BadgerWorkflow;
}): Communications | undefined {
  if (process.env.BADGER_LIVE_MODE !== 'true') return undefined;
  // The Cartesia-hosted agent posts directly to /internal/preferences. Refuse
  // live startup rather than exposing that state-changing route without auth.
  requiredEnv('BADGER_TOOL_SECRET');
  const planner = new SailPlanner({
    apiKey: requiredEnv('SAIL_API_KEY'),
    model: process.env.SAIL_MODEL,
    baseUrl: process.env.SAIL_BASE_URL,
    requestTimeoutMs: positiveNumber(process.env.SAIL_TIMEOUT_MS, 45_000),
    reasoningEffort: (process.env.SAIL_REASONING_EFFORT as 'none' | 'minimal' | 'low' | 'medium' | 'high' | undefined),
    completionWindow: sailCompletionWindow(process.env.SAIL_COMPLETION_WINDOW),
    researcher: new OpenAIOptionResearcher({
      apiKey: requiredEnv('OPENAI_API_KEY'),
      model: process.env.BADGER_RESEARCH_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
      requestTimeoutMs: positiveNumber(process.env.BADGER_RESEARCH_TIMEOUT_MS, 30_000),
      cacheTtlMs: positiveNumber(process.env.BADGER_RESEARCH_CACHE_TTL_MS, 30 * 60_000),
      reasoningEffort: (process.env.BADGER_RESEARCH_REASONING_EFFORT as 'none' | 'low' | 'medium' | 'high' | undefined),
    }),
    locationHint: process.env.BADGER_DEFAULT_LOCATION ?? 'San Francisco Bay Area',
    emitReasoning: (sessionId, summary) => {
      input.events.append(sessionId, 'sail.reasoning', summary);
    },
    emitProgress: (sessionId, summary) => {
      input.events.append(sessionId, 'research.progress', summary);
    },
    loadHistory: (sessionId) => input.sessions.getSailHistory(sessionId),
    saveHistory: (sessionId, history) => input.sessions.saveSailHistory(sessionId, history),
    appendHistory: (sessionId, items) => input.sessions.appendSailHistory(sessionId, items),
  });
  return new LiveCommunications({
    ...input,
    cartesia: new CartesiaClient({
      apiKey: requiredEnv('CARTESIA_API_KEY'),
      agentId: requiredEnv('CARTESIA_AGENT_ID'),
      fromNumberId: requiredEnv('CARTESIA_FROM_NUMBER_ID'),
      baseUrl: process.env.CARTESIA_BASE_URL,
      requestTimeoutMs: positiveNumber(process.env.CARTESIA_REQUEST_TIMEOUT_MS, 10_000),
    }),
    spectrum: new SpectrumMessagingClient({
      projectId: requiredEnv('SPECTRUM_PROJECT_ID'),
      projectSecret: requiredEnv('SPECTRUM_PROJECT_SECRET'),
    }),
    cartesiaWebhookSecret: requiredEnv('CARTESIA_WEBHOOK_SECRET'),
    planner,
    inboundPlanner: new OpenAIFastInboundPlanner({
      apiKey: requiredEnv('OPENAI_API_KEY'),
      model: process.env.BADGER_FAST_INBOUND_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
      requestTimeoutMs: positiveNumber(process.env.BADGER_FAST_INBOUND_TIMEOUT_MS, 2_000),
    }),
    callDelayMs: positiveNumber(process.env.BADGER_CALL_DELAY_MS, 10_000),
    callStaggerMs: positiveNumber(process.env.BADGER_CALL_STAGGER_MS, 1_000),
  });
}
