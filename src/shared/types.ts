export type SessionStatus =
  | "DRAFT"
  | "CONTACTING"
  | "COLLECTING"
  | "MATCHING"
  | "PROPOSING"
  | "RESOLVING"
  | "COMMITTED"
  | "CANCELLED";

export type ParticipantStatus =
  | "PENDING"
  | "TEXTED"
  | "CALLING"
  | "IN_CALL"
  | "RESPONDED"
  | "NEEDS_FOLLOWUP"
  | "PROPOSED"
  | "CONFIRMED"
  | "DECLINED";

export interface Preferences {
  availability: string[];
  hardVetoes: string[];
  preferences: string[];
  flexibility: number;
  summary: string;
}

export interface Candidate {
  id: string;
  theater: string;
  time: string;
  slot: string;
  format: string;
  price: number;
  location: string;
}

export interface Participant {
  id: string;
  sessionId: string;
  name: string;
  phone: string;
  required: boolean;
  status: ParticipantStatus;
  preferences?: Preferences;
}

export interface Session {
  id: string;
  hostName: string;
  goal: string;
  status: SessionStatus;
  selectedCandidateId?: string;
  createdAt: string;
  updatedAt: string;
  participants: Participant[];
  candidates: Candidate[];
}

export type BadgerEventType =
  | "message.sent"
  | "message.received"
  | "call.requested"
  | "call.ringing"
  | "call.started"
  | "call.turn"
  | "call.completed"
  | "call.failed"
  | "preferences.received";

export interface BadgerEvent {
  id: string;
  sessionId: string;
  participantId?: string;
  type: BadgerEventType | (string & {});
  timestamp: string;
  publicMessage: string;
  privateData: Record<string, unknown>;
}

export interface CreateSessionInput {
  hostName: string;
  goal: string;
}

export interface AddParticipantInput {
  name: string;
  phone: string;
  required?: boolean;
}

export interface ParticipantPreferences extends Preferences {
  participantId: string;
}

export type CallMetadata = {
  sessionId: string;
  participantId: string;
  participantName: string;
  hostName: string;
  goal: string;
};

export type EventSink = (event: BadgerEvent) => void | Promise<void>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function parseCallMetadata(value: unknown): CallMetadata {
  if (!isRecord(value)) throw new Error("metadata must be an object");

  return {
    sessionId: requireString(value.sessionId, "metadata.sessionId"),
    participantId: requireString(value.participantId, "metadata.participantId"),
    participantName: requireString(value.participantName, "metadata.participantName"),
    hostName: requireString(value.hostName, "metadata.hostName"),
    goal: requireString(value.goal, "metadata.goal"),
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

export function parseParticipantPreferences(value: unknown): ParticipantPreferences {
  if (!isRecord(value)) throw new Error("preferences must be an object");

  const flexibility = Number(value.flexibility);
  if (!Number.isFinite(flexibility) || flexibility < 0 || flexibility > 1) {
    throw new Error("preferences.flexibility must be between 0 and 1");
  }

  return {
    participantId: requireString(value.participantId, "preferences.participantId"),
    availability: stringArray(value.availability, "preferences.availability"),
    hardVetoes: stringArray(value.hardVetoes, "preferences.hardVetoes"),
    preferences: stringArray(value.preferences, "preferences.preferences"),
    flexibility,
    summary: requireString(value.summary, "preferences.summary"),
  };
}
