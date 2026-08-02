import type { Candidate, Participant, Preferences, Session } from '../shared/types';

export const DEMO_HOST = 'Kaustubh';
export const DEMO_HOST_PHONE = '+1 415 555 0100';
export const DEMO_GOAL = 'See The Odyssey this weekend';

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
// TODO(demo): swap for the three real participant phones.
export const DEMO_PARTICIPANTS: DraftParticipant[] = [
  { name: 'Sam', phone: '+1 415 555 0101', required: true },
  { name: 'Jessica', phone: '+1 415 555 0102', required: true },
  { name: 'William', phone: '+1 415 555 0103', required: true },
];

// Slots mirror src/backend/mocks.ts so live-mode injection produces the same story.
export const DEMO_CANDIDATES: Candidate[] = [
  { id: 'cand_fri_imax', theater: 'AMC Metreon', time: 'Friday 9:20 PM', slot: 'friday_after_8', format: 'IMAX', price: 24, location: 'San Francisco' },
  { id: 'cand_sat_matinee', theater: 'Regal Stonestown', time: 'Saturday 2:10 PM', slot: 'saturday_afternoon', format: 'Standard', price: 19, location: 'San Francisco' },
  { id: 'cand_sat_imax', theater: 'AMC Metreon', time: 'Saturday 8:30 PM', slot: 'saturday_evening', format: 'IMAX', price: 24, location: 'San Francisco' },
  { id: 'cand_sun', theater: 'Alamo Drafthouse New Mission', time: 'Sunday 4:00 PM', slot: 'sunday_afternoon', format: 'Standard', price: 18, location: 'San Francisco' },
];

/**
 * Preference fixtures by participant index. The last participant is always the
 * blocker: available Saturday only, vetoes Friday night, but highly flexible —
 * which is exactly who the backend's resolver chooses to follow up with.
 */
const FIXTURES: Preferences[] = [
  {
    availability: ['friday_after_8', 'saturday_afternoon'],
    hardVetoes: ['saturday_evening'],
    preferences: ['imax'],
    flexibility: 0.7,
    summary: 'Available Friday after 8 or Saturday afternoon. Prefers IMAX.',
  },
  {
    availability: ['friday_after_8'],
    hardVetoes: ['sunday_afternoon'],
    preferences: ['closer_to_sf'],
    flexibility: 0.5,
    summary: 'Friday evening only.',
  },
  {
    availability: ['friday_after_8', 'saturday_afternoon', 'sunday_afternoon'],
    hardVetoes: [],
    preferences: [],
    flexibility: 0.6,
    summary: 'Pretty open all weekend.',
  },
];

export const BLOCKER_PREFS: Preferences = {
  availability: ['saturday_afternoon'],
  hardVetoes: ['friday_after_8'],
  preferences: [],
  flexibility: 0.9,
  summary: 'Prefers Saturday. Friday evening is tough but negotiable.',
};

export const BLOCKER_RESOLVED_PREFS: Preferences = {
  availability: ['saturday_afternoon', 'friday_after_8'],
  hardVetoes: [],
  preferences: [],
  flexibility: 0.9,
  summary: 'Confirmed Friday evening works after all.',
};

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
    candidates: DEMO_CANDIDATES.map((c) => ({ ...c })),
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
