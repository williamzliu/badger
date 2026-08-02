import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AddParticipantInput, CreateSessionInput, Participant, ParticipantStatus, Preferences, Session, SessionStatus } from '../shared/types.js';

type SessionRow = { id: string; host_name: string; goal: string; status: SessionStatus; selected_candidate_id: string | null; created_at: string; updated_at: string; };
type ParticipantRow = { id: string; session_id: string; name: string; phone: string; required: number; status: ParticipantStatus; preferences_json: string | null; };

export class SessionStore {
  constructor(private readonly db: Database.Database) {}
  create(input: CreateSessionInput): Session {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, input.hostName.trim(), input.goal.trim(), 'DRAFT', null, now, now);
    return this.get(id)!;
  }
  get(id: string): Session | undefined {
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!session) return undefined;
    const participants = this.db.prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY rowid').all(id) as ParticipantRow[];
    return { id: session.id, hostName: session.host_name, goal: session.goal, status: session.status, selectedCandidateId: session.selected_candidate_id ?? undefined, createdAt: session.created_at, updatedAt: session.updated_at, participants: participants.map((p) => ({ id: p.id, sessionId: p.session_id, name: p.name, phone: p.phone, required: Boolean(p.required), status: p.status, preferences: p.preferences_json ? JSON.parse(p.preferences_json) as Preferences : undefined })) };
  }
  addParticipant(session: Session, input: AddParticipantInput): Participant {
    if (session.status !== 'DRAFT') throw new Error('Participants can only be added to a draft session');
    const participant: Participant = { id: randomUUID(), sessionId: session.id, name: input.name.trim(), phone: input.phone.trim(), required: input.required ?? true, status: 'PENDING' };
    this.db.prepare('INSERT INTO participants VALUES (?, ?, ?, ?, ?, ?, ?)').run(participant.id, participant.sessionId, participant.name, participant.phone, Number(participant.required), participant.status, null);
    this.touch(session.id); return participant;
  }
  updateSession(session: Session): void { this.db.prepare('UPDATE sessions SET status = ?, selected_candidate_id = ?, updated_at = ? WHERE id = ?').run(session.status, session.selectedCandidateId ?? null, new Date().toISOString(), session.id); }
  updateParticipant(participant: Participant): void { this.db.prepare('UPDATE participants SET status = ?, preferences_json = ? WHERE id = ?').run(participant.status, participant.preferences ? JSON.stringify(participant.preferences) : null, participant.id); this.touch(participant.sessionId); }
  receiveWebhook(provider: string, webhookId: string): boolean { if (!webhookId) return false; try { this.db.prepare('INSERT INTO webhook_receipts VALUES (?, ?, ?)').run(provider, webhookId, new Date().toISOString()); return false; } catch { return true; } }
  private touch(sessionId: string): void { this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId); }
}
