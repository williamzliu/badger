import type { Candidate, Participant, Preferences, Session } from '../shared/types';
import { candidatesForGoal } from '../shared/candidates';

export const DEMO_HOST = 'Kaustubh';
export const DEMO_GOAL = 'See The Odyssey this weekend';

// Real numbers stay out of git: set VITE_DEMO_PHONE_* in .env (untracked).
const env = import.meta.env as Record<string, string | undefined>;
export const DEMO_HOST_PHONE = env.VITE_DEMO_PHONE_HOST || '+1 415 555 0100';

export interface DraftParticipant {
  name: string;
  phone: string;
  required: boolean;
}

export interface DraftInput {
  hostName: string;
  hostPhone?: string;
  goal: string;
  participants: DraftParticipant[];
}

// The host is prepended as a participant at draft time (Badger calls you too).
// The last participant is the demo's conflict blocker.
export const DEMO_PARTICIPANTS: DraftParticipant[] = [
  { name: 'Sam', phone: env.VITE_DEMO_PHONE_SAM || '+1 415 555 0101', required: true },
  { name: 'Dana', phone: env.VITE_DEMO_PHONE_DANA || '+1 415 555 0102', required: true },
  { name: 'William', phone: env.VITE_DEMO_PHONE_WILLIAM || '+1 415 555 0103', required: true },
];

/**
 * Preference fixtures by participant index. The demo goal is a weekend plan,
 * so every window here must be a saturday or sunday slot that
 * candidatesForGoal actually generates. The last participant is always the
 * blocker: only free Sunday morning while everyone else converges on Saturday
 * afternoon, but highly flexible — which is exactly who the backend's resolver
 * chooses to follow up with. The blocker must not hard-veto the group's slot,
 * or matching would exclude it entirely instead of negotiating.
 */
const FIXTURES: Preferences[] = [
  {
    availability: ['saturday_afternoon'],
    hardVetoes: ['saturday_evening'],
    preferences: [],
    flexibility: 0.7,
    summary: 'Available Saturday afternoon.',
  },
  {
    availability: ['saturday_afternoon'],
    hardVetoes: ['sunday_afternoon'],
    preferences: [],
    flexibility: 0.5,
    summary: 'Saturday afternoon only.',
  },
  {
    availability: ['saturday_afternoon', 'sunday_morning', 'sunday_afternoon'],
    hardVetoes: [],
    preferences: [],
    flexibility: 0.6,
    summary: 'Pretty open all weekend.',
  },
];

export const BLOCKER_PREFS: Preferences = {
  availability: ['sunday_morning'],
  hardVetoes: [],
  preferences: [],
  flexibility: 0.9,
  summary: 'Prefers Sunday morning. Saturday afternoon is tough but negotiable.',
};

export const BLOCKER_RESOLVED_PREFS: Preferences = {
  availability: ['sunday_morning', 'saturday_afternoon'],
  hardVetoes: [],
  preferences: [],
  flexibility: 0.9,
  summary: 'Confirmed Saturday afternoon works after all.',
};

/** The slot the demo resolves onto once the blocker flexes. */
export const DEMO_WINNER_SLOT = 'saturday_afternoon';

export function isBlocker(session: Session, participant: Participant): boolean {
  return session.participants[session.participants.length - 1]?.id === participant.id;
}

export function prefsFor(session: Session, participant: Participant): Preferences {
  if (isBlocker(session, participant)) return BLOCKER_PREFS;
  const index = session.participants.findIndex((p) => p.id === participant.id);
  return FIXTURES[index >= 0 ? index % FIXTURES.length : 0];
}

let draftCounter = 0;

export function makeDraftSession(input: DraftInput): Session {
  const now = new Date().toISOString();
  const id = `demo_${++draftCounter}`;
  return {
    id,
    hostName: input.hostName,
    goal: input.goal,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    candidates: candidatesForGoal(input.goal).map((c: Candidate) => ({ ...c })),
    participants: input.participants.map((p, i) => ({
      id: `p_${i + 1}`,
      sessionId: id,
      name: p.name,
      phone: p.phone,
      required: p.required,
      status: 'PENDING',
    })),
  };
}
