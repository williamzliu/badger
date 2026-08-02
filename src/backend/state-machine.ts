import { type Candidate, type Participant, type Preferences, type Session } from '../shared/types.js';
import { EventLog } from './events.js';
import { SessionStore } from './sessions.js';

export function matchesSlot(constraint: string, slot: string): boolean {
  const normalized = constraint.toLowerCase().replaceAll(' ', '_');
  const day = slot.split('_')[0];
  if (normalized === `${day}_anytime` || normalized === `anytime_${day}`) return true;
  if (/^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)_anytime$/.test(normalized)) return false;
  if (
    ['all_day', 'any_time', 'anytime', 'all_times'].includes(normalized) ||
    normalized.includes('any_time') ||
    normalized.includes('anytime')
  ) {
    if (normalized.includes('weekend')) return /^(?:saturday|sunday)_/.test(slot);
    return true;
  }
  if (normalized === slot) return true;
  if (normalized === day || normalized === `${day}_all_day`) return true;
  const namesDayWithoutPeriod =
    normalized.includes(day!) &&
    !/(?:morning|afternoon|evening|night|after|before|\d)/.test(normalized);
  if (namesDayWithoutPeriod) return true;
  if (slot === `${day}_evening` && new RegExp(`^${day}_(?:night|after_(?:5|6|7|8|9|10|11|12))`).test(normalized)) {
    return true;
  }
  return false;
}

export function matchesCandidateConstraint(constraint: string, candidate: Candidate): boolean {
  const normalized = constraint.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (normalized.startsWith('outside_')) {
    const allowed = normalized.slice('outside_'.length).split('_').filter((token) => token.length > 2);
    const location = `${candidate.location} ${candidate.theater}`.toLowerCase();
    return allowed.length > 0 && !allowed.every((token) => location.includes(token));
  }
  return matchesSlot(normalized, candidate.slot);
}

export function isCandidateFeasible(candidate: Candidate, participant: Participant): boolean {
  const preferences = participant.preferences;
  return Boolean(
    preferences &&
    preferences.availability.some((window) => matchesSlot(window, candidate.slot)) &&
    !preferences.hardVetoes.some((window) => matchesCandidateConstraint(window, candidate)),
  );
}

export class BadgerWorkflow {
  constructor(
    private readonly sessions: SessionStore,
    private readonly events: EventLog,
  ) {}

  start(session: Session): Session {
    if (session.status !== 'DRAFT') throw new Error('Only draft sessions can start');
    if (!session.participants.length) throw new Error('Add at least one participant before starting');

    session.status = 'CONTACTING';
    this.sessions.updateSession(session);
    this.events.append(session.id, 'session.started', `Contacting ${session.participants.length} people…`);
    for (const participant of session.participants) {
      participant.status = 'TEXTED';
      this.sessions.updateParticipant(participant);
      this.events.append(session.id, 'message.queued', `Contacting ${participant.name}`, {
        participantId: participant.id,
      });
    }
    session.status = 'COLLECTING';
    this.sessions.updateSession(session);
    return session;
  }

  markCalling(session: Session, participant: Participant): void {
    if (['DECLINED', 'CONFIRMED', 'RESPONDED', 'PROPOSED'].includes(participant.status)) return;
    participant.status = 'CALLING';
    this.sessions.updateParticipant(participant);
  }

  markInCall(session: Session, participant: Participant): void {
    if (['DECLINED', 'CONFIRMED', 'RESPONDED', 'PROPOSED'].includes(participant.status)) return;
    participant.status = 'IN_CALL';
    this.sessions.updateParticipant(participant);
  }

  markCallFinished(session: Session, participant: Participant, restoreFollowUp = false): void {
    if (!['CALLING', 'IN_CALL'].includes(participant.status)) return;
    participant.status = restoreFollowUp ? 'NEEDS_FOLLOWUP' : 'TEXTED';
    this.sessions.updateParticipant(participant);
  }

  recordPreferences(session: Session, participant: Participant, preferences: Preferences): Session {
    if (!['COLLECTING', 'RESOLVING'].includes(session.status)) {
      throw new Error('Preferences are not being collected');
    }
    const priorAsk = participant.status === 'NEEDS_FOLLOWUP'
      ? { participantId: participant.id, candidateId: session.selectedCandidateId }
      : undefined;
    participant.preferences = preferences;
    participant.status = 'RESPONDED';
    this.sessions.updateParticipant(participant);
    this.events.append(session.id, 'preferences.received', `${participant.name}'s availability received`, {
      participantId: participant.id,
      preferences,
    });
    this.evaluate(session, priorAsk);
    return session;
  }

  acceptFlexibility(session: Session, participant: Participant): Session {
    if (session.status !== 'RESOLVING' || participant.status !== 'NEEDS_FOLLOWUP') {
      throw new Error('Participant is not the active flexibility target');
    }
    const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
    if (!candidate || !participant.preferences) throw new Error('No candidate is awaiting flexibility');

    const availability = [...new Set([...participant.preferences.availability, candidate.slot])];
    const hardVetoes = participant.preferences.hardVetoes.filter((item) => item !== candidate.slot);
    this.events.append(session.id, 'conflict.resolved', 'Conflict resolved', {
      participantId: participant.id,
      candidateId: candidate.id,
    });
    return this.recordPreferences(session, participant, {
      ...participant.preferences,
      availability,
      hardVetoes,
      summary: `${participant.preferences.summary} Confirmed ${candidate.time} works.`,
    });
  }

  confirm(session: Session, participant: Participant): Session {
    if (session.status !== 'PROPOSING') throw new Error('There is no active proposal');
    if (participant.status !== 'PROPOSED') throw new Error('Participant has no active proposal');

    participant.status = 'CONFIRMED';
    this.sessions.updateParticipant(participant);
    this.events.append(session.id, 'proposal.confirmed', `${participant.name} confirmed`, {
      participantId: participant.id,
    });

    const required = session.participants.filter((item) => item.required);
    if (required.every((item) => item.status === 'CONFIRMED')) {
      session.status = 'COMMITTED';
      this.sessions.updateSession(session);
      this.events.append(session.id, 'plan.committed', `${required.length}/${required.length} committed`, {
        candidateId: session.selectedCandidateId,
      });
    }
    return session;
  }

  applyPlannerDecision(
    session: Session,
    decision: { action: string; candidateId: string; participantId: string | null },
  ): Session {
    const candidate = session.candidates.find((item) => item.id === decision.candidateId);
    if (!candidate) throw new Error('Planner candidate not found');
    if (session.status === 'PROPOSING' && decision.action === 'PROPOSE_PLAN') {
      if (session.selectedCandidateId !== candidate.id) {
        session.selectedCandidateId = candidate.id;
        this.sessions.updateSession(session);
        this.events.append(session.id, 'plan.replanned', `Sail selected ${candidate.time} at ${candidate.theater}`, {
          candidateId: candidate.id,
        });
      }
      return session;
    }
    if (session.status === 'RESOLVING' && decision.action === 'REQUEST_FLEXIBILITY') {
      const target = session.participants.find((participant) => participant.id === decision.participantId);
      if (!target) throw new Error('Planner flexibility target not found');
      const previousTarget = session.participants.find((participant) => participant.status === 'NEEDS_FOLLOWUP');
      if (previousTarget?.id !== target.id) {
        if (previousTarget) {
          previousTarget.status = 'RESPONDED';
          this.sessions.updateParticipant(previousTarget);
        }
        target.status = 'NEEDS_FOLLOWUP';
        this.sessions.updateParticipant(target);
      }
      if (session.selectedCandidateId !== candidate.id || previousTarget?.id !== target.id) {
        session.selectedCandidateId = candidate.id;
        this.sessions.updateSession(session);
        this.events.append(session.id, 'conflict.strategy_selected', `Sail chose to ask ${target.name}`, {
          participantId: target.id,
          candidateId: candidate.id,
        });
      }
      return session;
    }
    if (session.status === 'COMMITTED' && decision.action === 'COMMIT_PLAN') return session;
    throw new Error(`Planner action ${decision.action} cannot be applied while session is ${session.status}`);
  }

  rejectCandidate(session: Session, participant: Participant, replacement?: Preferences): Session {
    const canReject =
      (session.status === 'PROPOSING' && ['PROPOSED', 'CONFIRMED'].includes(participant.status)) ||
      (session.status === 'RESOLVING' && participant.status === 'NEEDS_FOLLOWUP');
    const candidate = session.candidates.find((item) => item.id === session.selectedCandidateId);
    if (!canReject || !candidate || !participant.preferences) {
      throw new Error('Participant has no active candidate to reject');
    }

    for (const member of session.participants) {
      if (['PROPOSED', 'CONFIRMED', 'NEEDS_FOLLOWUP'].includes(member.status)) {
        member.status = 'RESPONDED';
        this.sessions.updateParticipant(member);
      }
    }
    session.status = 'COLLECTING';
    session.selectedCandidateId = undefined;
    this.sessions.updateSession(session);
    this.events.append(session.id, 'proposal.rejected', `${participant.name} cannot make that showing`, {
      participantId: participant.id,
      candidateId: candidate.id,
    });
    const next = replacement ?? participant.preferences;
    return this.recordPreferences(session, participant, {
      ...next,
      availability: next.availability.filter((slot) => slot !== candidate.slot),
      hardVetoes: [...new Set([...next.hardVetoes, candidate.slot])],
      summary: `${next.summary} Cannot make ${candidate.time}.`,
    });
  }

  decline(session: Session, participant: Participant): Session {
    // A committed plan stays committed; a cancelled session stays quiet. A
    // stray "no" after the finale must not flip the outcome on screen.
    if (['COMMITTED', 'CANCELLED'].includes(session.status)) return session;
    if (participant.status === 'DECLINED') return session;
    participant.status = 'DECLINED';
    this.sessions.updateParticipant(participant);
    this.events.append(session.id, 'participant.declined', `${participant.name} declined`, {
      participantId: participant.id,
    });
    if (participant.required) {
      session.status = 'CANCELLED';
      this.sessions.updateSession(session);
      this.events.append(session.id, 'session.cancelled', 'A required participant declined');
    }
    return session;
  }

  private evaluate(
    session: Session,
    priorAsk?: { participantId: string; candidateId: string | undefined },
  ): void {
    const required = session.participants.filter((item) => item.required);
    if (!required.length || !required.every((item) => item.preferences)) return;

    session.status = 'MATCHING';
    this.sessions.updateSession(session);
    this.events.append(session.id, 'matching.started', 'Checking viable options…');

    const eligible = session.candidates.filter((candidate) =>
      required.every((participant) => !participant.preferences?.hardVetoes.some(
        (window) => matchesCandidateConstraint(window, candidate),
      )));
    const viable = eligible.filter((candidate) =>
      required.every((participant) => isCandidateFeasible(candidate, participant)),
    );
    if (viable.length) {
      this.propose(session, required, viable[0]!);
      return;
    }

    const ranked = eligible
      .map((candidate) => ({
        candidate,
        feasible: required.filter((participant) => isCandidateFeasible(candidate, participant)).length,
        blockers: required.filter((participant) => !isCandidateFeasible(candidate, participant)),
      }))
      .sort((a, b) => b.feasible - a.feasible);
    const best = ranked[0];
    if (!best || !best.blockers.length) {
      // The researched set is exhausted, not the group. Ask the participant
      // with the most room to maneuver for a wider window instead of falsely
      // declaring that the entire plan is off.
      for (const member of required) {
        if (member.status === 'NEEDS_FOLLOWUP') {
          member.status = 'RESPONDED';
          this.sessions.updateParticipant(member);
        }
      }
      const target = [...required].sort(
        (a, b) => (b.preferences?.flexibility ?? 0) - (a.preferences?.flexibility ?? 0),
      )[0]!;
      target.status = 'NEEDS_FOLLOWUP';
      this.sessions.updateParticipant(target);
      session.selectedCandidateId = undefined;
      session.status = 'RESOLVING';
      this.sessions.updateSession(session);
      this.events.append(session.id, 'conflict.detected', 'The current options need a wider search', {});
      this.events.append(session.id, 'flexibility.requested', `Asking ${target.name} for another workable window`, {
        participantId: target.id,
      });
      return;
    }

    // Capture the outstanding ask before clearing, so an unchanged
    // target+candidate doesn't re-emit conflict events on every evaluate.
    const previousTargetId = priorAsk?.participantId ??
      session.participants.find((m) => m.status === 'NEEDS_FOLLOWUP')?.id;
    const previousCandidateId = priorAsk?.candidateId ?? session.selectedCandidateId;

    // Clear any stale follow-up target from a previous resolution round so
    // exactly one participant is ever NEEDS_FOLLOWUP.
    for (const member of session.participants) {
      if (member.status === 'NEEDS_FOLLOWUP') {
        member.status = 'RESPONDED';
        this.sessions.updateParticipant(member);
      }
    }
    const target = [...best.blockers].sort(
      (a, b) => (b.preferences?.flexibility ?? 0) - (a.preferences?.flexibility ?? 0),
    )[0]!;
    session.selectedCandidateId = best.candidate.id;
    session.status = 'RESOLVING';
    target.status = 'NEEDS_FOLLOWUP';
    this.sessions.updateParticipant(target);
    this.sessions.updateSession(session);
    const sameAsk = previousTargetId === target.id && previousCandidateId === best.candidate.id;
    if (!sameAsk) {
      this.events.append(session.id, 'conflict.detected', 'One availability conflict detected', {
        candidateId: best.candidate.id,
        blockerCount: best.blockers.length,
      });
      this.events.append(session.id, 'flexibility.requested', `Asking ${target.name} about flexibility`, {
        participantId: target.id,
        candidateId: best.candidate.id,
      });
    }
  }

  private propose(session: Session, required: Participant[], candidate: Candidate): void {
    session.selectedCandidateId = candidate.id;
    session.status = 'PROPOSING';
    for (const participant of required) {
      participant.status = 'PROPOSED';
      this.sessions.updateParticipant(participant);
    }
    this.sessions.updateSession(session);
    this.events.append(session.id, 'plan.proposed', `Badger found ${candidate.time} at ${candidate.theater}`, {
      candidateId: candidate.id,
    });
  }
}
