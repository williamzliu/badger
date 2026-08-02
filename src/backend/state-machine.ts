import { type Candidate, type Participant, type Preferences, type Session } from '../shared/types.js';
import { EventLog } from './events.js';
import { SessionStore } from './sessions.js';

function isCandidateFeasible(candidate: Candidate, participant: Participant): boolean {
  const preferences = participant.preferences;
  return Boolean(
    preferences &&
    preferences.availability.includes(candidate.slot) &&
    !preferences.hardVetoes.includes(candidate.slot),
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

  decline(session: Session, participant: Participant): Session {
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
    this.events.append(session.id, 'matching.started', 'Checking viable showtimes…');

    const viable = session.candidates.filter((candidate) =>
      required.every((participant) => isCandidateFeasible(candidate, participant)),
    );
    if (viable.length) {
      this.propose(session, required, viable[0]!);
      return;
    }

    const ranked = session.candidates
      .map((candidate) => ({
        candidate,
        feasible: required.filter((participant) => isCandidateFeasible(candidate, participant)).length,
        blockers: required.filter((participant) => !isCandidateFeasible(candidate, participant)),
      }))
      .sort((a, b) => b.feasible - a.feasible);
    const best = ranked[0];
    if (!best || !best.blockers.length) throw new Error('No candidate available for conflict resolution');

    const target = [...best.blockers].sort(
      (a, b) => (b.preferences?.flexibility ?? 0) - (a.preferences?.flexibility ?? 0),
    )[0]!;
    session.selectedCandidateId = best.candidate.id;
    session.status = 'RESOLVING';
    target.status = 'NEEDS_FOLLOWUP';
    this.sessions.updateParticipant(target);
    this.sessions.updateSession(session);
    this.events.append(session.id, 'conflict.detected', 'One availability conflict detected', {
      candidateId: best.candidate.id,
      blockerCount: best.blockers.length,
    });
    this.events.append(session.id, 'flexibility.requested', `Asking ${target.name} about flexibility`, {
      participantId: target.id,
      candidateId: best.candidate.id,
    });
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
