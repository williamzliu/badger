import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type AddParticipantInput,
  type CallMetadata,
  type Candidate,
  type CreateSessionInput,
  type Participant,
  type ParticipantStatus,
  type Preferences,
  type Session,
  type SessionStatus,
} from '../shared/types.js';
import { mockCandidates } from './mocks.js';
type SessionRow = {
  id: string;
  host_name: string;
  goal: string;
  status: SessionStatus;
  selected_candidate_id: string | null;
  created_at: string;
  updated_at: string;
};

type ParticipantRow = {
  id: string;
  session_id: string;
  name: string;
  phone: string;
  required: number;
  status: ParticipantStatus;
  preferences_json: string | null;
};

function normalizeE164(phone: string): string {
  const normalized = `+${phone.replace(/\D/g, '')}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error('Phone must be a valid E.164 number');
  }
  return normalized;
}

function participantFromRow(row: ParticipantRow): Participant {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    phone: row.phone,
    required: Boolean(row.required),
    status: row.status,
    ...(row.preferences_json ? { preferences: JSON.parse(row.preferences_json) as Preferences } : {}),
  };
}

export class SessionStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateSessionInput): Session {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      input.hostName.trim(),
      input.goal.trim(),
      'DRAFT',
      null,
      now,
      now,
    );
    this.db.transaction(() => {
      for (const candidate of mockCandidates) {
        this.db.prepare('INSERT INTO candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          randomUUID(),
          id,
          candidate.theater,
          candidate.time,
          candidate.slot,
          candidate.format,
          candidate.price,
          candidate.location,
        );
      }
    })();
    return this.get(id)!;
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as SessionRow | undefined;
    if (!row) return undefined;
    const participants = (
      this.db.prepare('SELECT * FROM participants WHERE session_id=? ORDER BY rowid').all(id) as ParticipantRow[]
    ).map(participantFromRow);
    const candidates = this.db.prepare('SELECT * FROM candidates WHERE session_id=? ORDER BY rowid').all(id) as Candidate[];
    return {
      id: row.id,
      hostName: row.host_name,
      goal: row.goal,
      status: row.status,
      ...(row.selected_candidate_id ? { selectedCandidateId: row.selected_candidate_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      participants,
      candidates,
    };
  }

  addParticipant(session: Session, input: AddParticipantInput): Participant {
    if (session.status !== 'DRAFT') throw new Error('Participants can only be added to a draft session');
    const participant: Participant = {
      id: randomUUID(),
      sessionId: session.id,
      name: input.name.trim(),
      phone: normalizeE164(input.phone),
      required: input.required ?? true,
      status: 'PENDING',
    };
    this.db.prepare('INSERT INTO participants VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      participant.id,
      participant.sessionId,
      participant.name,
      participant.phone,
      Number(participant.required),
      participant.status,
      null,
    );
    this.touch(session.id);
    return participant;
  }

  updateSession(session: Session): void {
    this.db.prepare('UPDATE sessions SET status=?,selected_candidate_id=?,updated_at=? WHERE id=?').run(
      session.status,
      session.selectedCandidateId ?? null,
      new Date().toISOString(),
      session.id,
    );
  }

  updateParticipant(participant: Participant): void {
    this.db.prepare('UPDATE participants SET status=?,preferences_json=? WHERE id=?').run(
      participant.status,
      participant.preferences ? JSON.stringify(participant.preferences) : null,
      participant.id,
    );
    this.touch(participant.sessionId);
  }

  findActiveParticipantByPhone(phone: string): { session: Session; participant: Participant } | undefined {
    // Inbound senders can be short codes or email-based iMessage IDs — those
    // are simply "no match", never an exception that kills the reply listener.
    let normalized: string;
    try {
      normalized = normalizeE164(phone);
    } catch {
      return undefined;
    }
    const row = this.db.prepare(`
      SELECT p.* FROM participants p
      JOIN sessions s ON s.id = p.session_id
      WHERE p.phone = ? AND s.status NOT IN ('COMMITTED', 'CANCELLED')
      ORDER BY s.updated_at DESC
      LIMIT 1
    `).get(normalized) as ParticipantRow | undefined;
    if (!row) return undefined;
    const session = this.get(row.session_id);
    if (!session) return undefined;
    const participant = session.participants.find((item) => item.id === row.id);
    return participant ? { session, participant } : undefined;
  }

  rememberCall(callId: string, metadata: CallMetadata): void {
    this.db.prepare('INSERT OR REPLACE INTO call_contexts VALUES (?, ?, ?)').run(
      callId,
      JSON.stringify(metadata),
      new Date().toISOString(),
    );
  }

  lookupCall(callId: string): CallMetadata | undefined {
    const row = this.db.prepare('SELECT metadata_json FROM call_contexts WHERE call_id=?').get(callId) as
      | { metadata_json: string }
      | undefined;
    return row ? JSON.parse(row.metadata_json) as CallMetadata : undefined;
  }

  getSailHistory(sessionId: string): Record<string, unknown>[] {
    const row = this.db.prepare('SELECT history_json FROM sail_conversations WHERE session_id=?').get(sessionId) as
      | { history_json: string }
      | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.history_json) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Invalid Sail history for session ${sessionId}`);
    return parsed as Record<string, unknown>[];
  }

  saveSailHistory(sessionId: string, history: Record<string, unknown>[]): void {
    this.db.prepare(`
      INSERT INTO sail_conversations (session_id, history_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET history_json=excluded.history_json, updated_at=excluded.updated_at
    `).run(sessionId, JSON.stringify(history), new Date().toISOString());
  }

  receiveWebhook(provider: string, id: string): boolean {
    if (!id) return false;
    try {
      this.db.prepare('INSERT INTO webhook_receipts VALUES (?, ?, ?)').run(provider, id, new Date().toISOString());
      return false;
    } catch {
      return true;
    }
  }

  releaseWebhook(provider: string, id: string): void {
    this.db.prepare('DELETE FROM webhook_receipts WHERE provider=? AND webhook_id=?').run(provider, id);
  }

  private touch(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(new Date().toISOString(), id);
  }
}
