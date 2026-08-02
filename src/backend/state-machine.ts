import { type Candidate, type Participant, type Preferences, type Session } from '../shared/types.js';
import { EventLog } from './events.js';
import { SessionStore } from './sessions.js';

function matchesSlot(constraint: string, slot: string): boolean {
  const normalized = constraint.toLowerCase().replaceAll(' ', '_');
  if (['all_day', 'any_time', 'anytime', 'all_times'].includes(normalized)) return true;
  if (normalized === slot) return true;
  const day = slot.split('_')[0];
  return normalized === day || normalized === `${day}_all_day`;
}

function isCandidateFeasible(candidate: Candidate, participant: Participant): boolean {
  const preferences = participant.preferences;
  return Boolean(
    preferences &&
    preferences.availability.some((window) => matchesSlot(window, candidate.slot)) &&
    !preferences.hardVetoes.some((window) => matchesSlot(window, candidate.slot)),
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

  markCallFinished(session: Session, participant: Participant): void {
    if (!['CALLING', 'IN_CALL'].includes(participant.status)) return;
    participant.status = 'TEXTED';
    this.sessions.updateParticipant(participant);
  }

  recordPreferences(session: Session, participant: Participant, preferences: Preferences): Session {
    if (!['COLLECTING', 'RESOLVING'].includes(session.status)) {
      throw new Error('Preferences are not being collected');
    }
    participant.preferences = preferences;
    participant.status = 'RESPONDED';
    this.sessions.updateParticipant(participant);
    this.events.append(session.id, 'preferences.received', `${participant.name}'s availability received`, {
      participantId: participant.id,
      preferences,
    });
    this.evaluate(session);
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

  rejectCandidate(session: Session, participant: Participant): Session {
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
    return this.recordPreferences(session, participant, {
      ...participant.preferences,
      availability: participant.preferences.availability.filter((slot) => slot !== candidate.slot),
      hardVetoes: [...new Set([...participant.preferences.hardVetoes, candidate.slot])],
      summary: `${participant.preferences.summary} Cannot make ${candidate.time}.`,
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

  private evaluate(session: Session): void {
    const required = session.participants.filter((item) => item.required);
    if (!required.length || !required.every((item) => item.preferences)) return;

    session.status = 'MATCHING';
    this.sessions.updateSession(session);
    this.events.append(session.id, 'matching.started', 'Checking viable options…');

    const eligible = session.candidates.filter((candidate) =>
      required.every((participant) => !participant.preferences?.hardVetoes.some(
        (window) => matchesSlot(window, candidate.slot),
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
      // Every option is vetoed — end gracefully. Throwing here used to leave
      // the session persisted in MATCHING with no legal transition out
      // (dashboard stuck on "Checking viable options…" forever).
      session.status = 'CANCELLED';
      this.sessions.updateSession(session);
      this.events.append(session.id, 'matching.failed', 'No option works for everyone', {});
      this.events.append(session.id, 'session.cancelled', 'No time works for everyone');
      return;
    }

    // Capture the outstanding ask before clearing, so an unchanged
    // target+candidate doesn't re-emit conflict events on every evaluate.
    const previousTargetId = session.participants.find((m) => m.status === 'NEEDS_FOLLOWUP')?.id;
    const previousCandidateId = session.selectedCandidateId;

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
