export type SessionStatus = 'DRAFT' | 'CONTACTING' | 'COLLECTING' | 'MATCHING' | 'PROPOSING' | 'RESOLVING' | 'COMMITTED' | 'CANCELLED';
export type ParticipantStatus = 'PENDING' | 'TEXTED' | 'CALLING' | 'IN_CALL' | 'RESPONDED' | 'NEEDS_FOLLOWUP' | 'PROPOSED' | 'CONFIRMED' | 'DECLINED';
export interface Preferences { availability: string[]; hardVetoes: string[]; preferences: string[]; flexibility: number; summary: string; }
export interface Candidate { id: string; theater: string; time: string; slot: string; format: string; price: number; location: string; }
export interface Participant { id: string; sessionId: string; name: string; phone: string; required: boolean; status: ParticipantStatus; preferences?: Preferences; }
export interface Session { id: string; hostName: string; goal: string; status: SessionStatus; selectedCandidateId?: string; createdAt: string; updatedAt: string; participants: Participant[]; candidates: Candidate[]; }
export interface BadgerEvent { id: string; sessionId: string; type: string; timestamp: string; publicMessage: string; privateData: Record<string, unknown>; }
export interface CreateSessionInput { hostName: string; goal: string; }
export interface AddParticipantInput { name: string; phone: string; required?: boolean; }
