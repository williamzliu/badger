import { EventLog } from './events.js';
import { SessionStore } from './sessions.js';
import { Session } from '../shared/types.js';

export class BadgerWorkflow {
  constructor(private readonly sessions: SessionStore, private readonly events: EventLog) {}

  start(session: Session): Session {
    if (session.status !== 'DRAFT') throw new Error('Only draft sessions can start');
    if (session.participants.length === 0) throw new Error('Add at least one participant before starting');

    session.status = 'CONTACTING';
    this.sessions.updateSession(session);
    this.events.append(session.id, 'session.started', `Contacting ${session.participants.length} people…`);

    for (const participant of session.participants) {
      participant.status = 'TEXTED';
      this.sessions.updateParticipant(participant);
      this.events.append(session.id, 'sms.queued', `Contacting ${participant.name}`, { participantId: participant.id });
    }

    session.status = 'COLLECTING';
    this.sessions.updateSession(session);
    return session;
  }
}
