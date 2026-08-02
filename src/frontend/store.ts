import { useSyncExternalStore } from 'react';
import type { Candidate, Session } from '../shared/types';

export type Mode = 'mock' | 'live';
export type UIPhase = 'create' | 'live' | 'proposal' | 'committed' | 'cancelled';
export type FeedKind = 'info' | 'sms' | 'call' | 'conflict' | 'success' | 'sail';

export interface FeedItem {
  id: string;
  timestamp: string;
  message: string;
  kind: FeedKind;
}

/**
 * The sanitized event shape the backend streams over SSE (privateData is
 * stripped server-side). The frontend renders publicMessage and nothing else.
 */
export interface PublicEventLike {
  id: string;
  sessionId?: string;
  type: string;
  timestamp: string;
  publicMessage: string;
}

export interface BadgerSnapshot {
  mode: Mode;
  session: Session | null;
  phase: UIPhase;
  launching: boolean;
  feed: FeedItem[];
  sailThoughts: FeedItem[];
  conflictActive: boolean;
  followUpName: string | null;
  selectedCandidate: Candidate | null;
  respondedCount: number;
  totalCount: number;
  confirmedCount: number;
  error: string | null;
}

const FEED_LIMIT = 200;
// SSE reconnects and synchronous workflow transitions can deliver several
// genuine milestones in one browser task. Reveal that burst sequentially so
// the operator can follow the work instead of seeing only the final snapshot.
const EVENT_REVEAL_MS = 320;

export function feedKindFor(type: string): FeedKind {
  if (type === 'sail.reasoning') return 'sail';
  if (type.startsWith('sms.') || type.startsWith('message.')) return 'sms';
  if (type.startsWith('call.')) return 'call';
  if (['conflict.detected', 'conflict.strategy_selected', 'flexibility.requested', 'participant.declined', 'session.cancelled', 'integration.failed', 'proposal.rejected', 'matching.failed'].includes(type)) return 'conflict';
  if (['research.completed', 'conflict.resolved', 'preferences.received', 'proposal.confirmed', 'plan.proposed', 'plan.committed'].includes(type)) return 'success';
  return 'info';
}

function derivePhase(session: Session | null): UIPhase {
  if (!session || session.status === 'DRAFT') return 'create';
  if (session.status === 'PROPOSING') return 'proposal';
  if (session.status === 'COMMITTED') return 'committed';
  if (session.status === 'CANCELLED') return 'cancelled';
  return 'live';
}

function storedMode(): Mode {
  try {
    return localStorage.getItem('badger.mode') === 'live' ? 'live' : 'mock';
  } catch {
    return 'mock';
  }
}

class BadgerStore {
  private listeners = new Set<() => void>();
  private seenEventIds = new Set<string>();
  private pendingEvents: PublicEventLike[] = [];
  private eventRevealTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: BadgerSnapshot = {
    mode: storedMode(),
    session: null,
    phase: 'create',
    launching: false,
    feed: [],
    sailThoughts: [],
    conflictActive: false,
    followUpName: null,
    selectedCandidate: null,
    respondedCount: 0,
    totalCount: 0,
    confirmedCount: 0,
    error: null,
  };

  getSnapshot = (): BadgerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(partial: Partial<BadgerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...partial };
    this.listeners.forEach((listener) => listener());
  }

  /** Authoritative session state — drives cards, phase, proposal, counts. */
  applySession(session: Session) {
    const responded = session.participants.filter(
      (p) => p.preferences || ['RESPONDED', 'PROPOSED', 'CONFIRMED'].includes(p.status),
    ).length;
    this.emit({
      session,
      phase: derivePhase(session),
      selectedCandidate: session.selectedCandidateId
        ? session.candidates.find((c) => c.id === session.selectedCandidateId) ?? null
        : null,
      followUpName: session.participants.find((p) => p.status === 'NEEDS_FOLLOWUP')?.name ?? null,
      conflictActive: session.status === 'RESOLVING',
      respondedCount: responded,
      totalCount: session.participants.length,
      confirmedCount: session.participants.filter((p) => p.status === 'CONFIRMED').length,
    });
  }

  /** Events feed the activity log. Deduped by id (SSE replays on reconnect). */
  applyEvent(event: PublicEventLike) {
    if (!event?.id || this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);
    if (!event.publicMessage) return;
    this.pendingEvents.push(event);
    this.revealNextEvent();
  }

  private revealNextEvent() {
    if (this.eventRevealTimer !== null) return;
    const event = this.pendingEvents.shift();
    if (!event) return;
    const item: FeedItem = {
      id: event.id,
      timestamp: event.timestamp,
      message: event.publicMessage,
      kind: feedKindFor(event.type),
    };
    if (item.kind === 'sail') {
      this.emit({ sailThoughts: [item, ...this.snapshot.sailThoughts].slice(0, 4) });
    } else {
      this.emit({ feed: [item, ...this.snapshot.feed].slice(0, FEED_LIMIT) });
    }
    this.eventRevealTimer = setTimeout(() => {
      this.eventRevealTimer = null;
      this.revealNextEvent();
    }, EVENT_REVEAL_MS);
  }

  setLaunching(launching: boolean) {
    this.emit({ launching });
  }

  setMode(mode: Mode) {
    this.emit({ mode });
  }

  setError(error: string | null) {
    this.emit({ error });
  }

  reset() {
    if (this.eventRevealTimer !== null) clearTimeout(this.eventRevealTimer);
    this.eventRevealTimer = null;
    this.pendingEvents = [];
    this.seenEventIds.clear();
    this.emit({
      session: null,
      phase: 'create',
      launching: false,
      feed: [],
      sailThoughts: [],
      conflictActive: false,
      followUpName: null,
      selectedCandidate: null,
      respondedCount: 0,
      totalCount: 0,
      confirmedCount: 0,
      error: null,
    });
  }
}

export const badger = new BadgerStore();

export function useBadger(): BadgerSnapshot {
  return useSyncExternalStore(badger.subscribe, badger.getSnapshot);
}
