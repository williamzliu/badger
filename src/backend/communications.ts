import type { BadgerEvent, CallMetadata, Participant, ParticipantPreferences, Session } from '../shared/types.js';
import { CartesiaClient, requestBadgerCall } from '../voice/cartesia.js';
import {
  MESSAGE_COPY,
  SpectrumMessagingClient,
  sendBadgerMessage,
  type InboundMessageIntent,
} from '../voice/spectrum.js';
import { CartesiaWebhookProcessor, type WebhookProcessResult } from '../voice/webhooks.js';
import { EventLog } from './events.js';
import { type GroupPlanner, type PlannerDecision, SailPlanner } from './sail.js';
import { SessionStore } from './sessions.js';
import { BadgerWorkflow } from './state-machine.js';
import { inferPreferencesFromText } from './text-replies.js';

export interface Communications {
  start(): Promise<void>;
  stop(): Promise<void>;
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

export class LiveCommunications implements Communications {
  private readonly abort = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
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
      emit: (event) => this.onSpectrumEvent(event),
    }));
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.config.spectrum.stop();
    await Promise.allSettled([...this.tasks]);
  }

  async contact(session: Session): Promise<void> {
    await Promise.all(session.participants.map(async (participant) => {
      try {
        await this.send(participant, MESSAGE_COPY.opening(session.hostName, session.goal), `opening:${session.id}:${participant.id}`);
      } catch (error) {
        this.integrationFailure(session, participant, 'opening message', error);
      }
    }));
    this.background(this.callParticipants(session.id));
  }

  async afterPreferences(session: Session, previousStatus: Session['status']): Promise<void> {
    if (session.status === 'RESOLVING') {
      const target = session.participants.find((participant) => participant.status === 'NEEDS_FOLLOWUP');
      const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
      if (!target || !candidate) return;
      const fallback = `Would ${candidate.time} at ${candidate.theater} work for you? Reply YES or tell me what blocks you.`;
      const planned = await this.plannedMessage(session, fallback, target);
      const sent = await this.safeSend(session, target, planned.message, `flex:${session.id}:${candidate.id}:${target.id}`);
      await this.recordPlannerOutcome(session, planned.decision, sent, sent ? 'Flexibility request sent' : 'Flexibility request failed');
      return;
    }
    if (session.status === 'PROPOSING') {
      const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
      if (!candidate) return;
      const planned = await this.plannedMessage(session, MESSAGE_COPY.proposal(candidate.time, candidate.theater));
      const sends = await Promise.all(session.participants
        .filter((participant) => participant.required && participant.status === 'PROPOSED')
        .map((participant) => this.safeSend(session, participant, planned.message, `proposal:${session.id}:${candidate.id}:${participant.id}`)));
      const sent = sends.every(Boolean);
      await this.recordPlannerOutcome(session, planned.decision, sent, sent ? 'Proposal sent to all required participants' : 'One or more proposal messages failed');
    }
  }

  async afterConfirmation(session: Session, previousStatus: Session['status']): Promise<void> {
    if (previousStatus === 'COMMITTED' || session.status !== 'COMMITTED') return;
    const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
    if (!candidate) return;
    const required = session.participants.filter((participant) => participant.required);
    const fallback = MESSAGE_COPY.commitment(candidate.time, candidate.theater, required.length, required.length);
    const planned = await this.plannedMessage(session, fallback);
    // Opt-out is a hard stop: declined participants get no further messages.
    const sends = await Promise.all(session.participants
      .filter((participant) => participant.status !== 'DECLINED')
      .map((participant) =>
        this.safeSend(session, participant, planned.message, `commit:${session.id}:${candidate.id}:${participant.id}`)));
    const sent = sends.every(Boolean);
    await this.recordPlannerOutcome(session, planned.decision, sent, sent ? 'Commitment sent to all participants' : 'One or more commitment messages failed');
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

  private async callParticipants(sessionId: string): Promise<void> {
    await delay(this.config.callDelayMs ?? 10_000, this.abort.signal);
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
      this.config.workflow.markCalling(session, participant);
      try {
        const metadata = callMetadata(session, participant);
        const placed = await requestBadgerCall(this.config.cartesia, {
          to: participant.phone,
          metadata,
          idempotencyKey: `call:${session.id}:${participant.id}`,
        }, (event) => { this.config.events.record(event); });
        this.config.sessions.rememberCall(placed.agentCallId, metadata);
      } catch (error) {
        const fresh = this.config.sessions.get(session.id);
        const freshParticipant = fresh?.participants.find((item) => item.id === participant.id);
        if (fresh && freshParticipant) {
          this.config.workflow.markCallFinished(fresh, freshParticipant);
          await this.safeSend(fresh, freshParticipant, MESSAGE_COPY.missedCall(), `missed:${session.id}:${participant.id}`);
        }
      }
    }));
  }

  private async onCartesiaEvent(event: BadgerEvent): Promise<void> {
    if (!this.config.events.record(event)) return;
    const session = this.config.sessions.get(event.sessionId);
    const participant = session?.participants.find((item) => item.id === event.participantId);
    if (!session || !participant) return;
    if (event.type === 'call.started') this.config.workflow.markInCall(session, participant);
    if (event.type === 'call.completed' || event.type === 'call.failed') {
      this.config.workflow.markCallFinished(session, participant);
    }
    if (event.type === 'call.failed') {
      await this.safeSend(session, participant, MESSAGE_COPY.missedCall(), `missed:${session.id}:${participant.id}`);
    }
    if (event.type === 'preferences.received' && !participant.preferences) {
      const submitted = event.privateData.preferences as ParticipantPreferences | undefined;
      if (!submitted) return;
      const previousStatus = session.status;
      this.config.workflow.recordPreferences(session, participant, submitted);
      const fresh = this.config.sessions.get(session.id);
      if (fresh) await this.afterPreferences(fresh, previousStatus);
    }
  }

  private async onSpectrumEvent(event: BadgerEvent): Promise<void> {
    if (!this.config.events.record(event)) return;
    const session = this.config.sessions.get(event.sessionId);
    const participant = session?.participants.find((item) => item.id === event.participantId);
    if (!session || !participant) return;
    const intent = event.privateData.intent as InboundMessageIntent | undefined;
    if (intent === 'opt_out') {
      this.config.workflow.decline(session, participant);
      return;
    }
    if (intent === 'decline') {
      const rejectsCandidate =
        (session.status === 'PROPOSING' && ['PROPOSED', 'CONFIRMED'].includes(participant.status)) ||
        (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP');
      if (!rejectsCandidate) {
        this.config.workflow.decline(session, participant);
        return;
      }
      const previousStatus = session.status;
      this.config.workflow.rejectCandidate(session, participant);
      const fresh = this.config.sessions.get(session.id);
      if (fresh) await this.afterPreferences(fresh, previousStatus);
      return;
    }
    if (intent === 'freeform') {
      const collecting = session.status === 'COLLECTING' && !participant.preferences;
      const followingUp = session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP';
      if (!collecting && !followingUp) return;
      const body = String(event.privateData.body ?? '');
      try {
        const preferences = inferPreferencesFromText(session, participant, body);
        if (!preferences) {
          await this.safeSend(
            session,
            participant,
            "I couldn't map that to an option. Reply with a day and time, like ‘Saturday evening’.",
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
    if (intent !== 'confirm') return;
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
    requestTimeoutMs: positiveNumber(process.env.SAIL_TIMEOUT_MS, 5_000),
    loadHistory: (sessionId) => input.sessions.getSailHistory(sessionId),
    saveHistory: (sessionId, history) => input.sessions.saveSailHistory(sessionId, history),
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
    callDelayMs: positiveNumber(process.env.BADGER_CALL_DELAY_MS, 10_000),
    callStaggerMs: positiveNumber(process.env.BADGER_CALL_STAGGER_MS, 1_000),
  });
}
