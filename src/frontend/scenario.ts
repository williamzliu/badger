import type { Session } from '../shared/types';
import { BLOCKER_PREFS, BLOCKER_RESOLVED_PREFS, prefsFor } from './fixtures';

export const CHECKPOINTS = ['launch', 'texted', 'calling', 'collecting', 'conflict', 'resolving', 'proposal', 'committed'] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

export interface Step {
  /** ms to wait before this step fires */
  delay: number;
  type: string;
  checkpoint?: Checkpoint;
  message: (session: Session) => string;
  apply?: (session: Session) => void;
}

/**
 * The scripted rehearsal timeline. Built against the actual session so custom
 * participant names flow through. The final participant is the blocker who
 * misses the call, replies by text, and creates the one conflict.
 */
export function buildScenario(session: Session): Step[] {
  const people = session.participants;
  const blocker = people[people.length - 1];
  const others = people.slice(0, -1);
  const winner = session.candidates[0];
  const steps: Step[] = [];

  steps.push({
    delay: 400,
    type: 'session.started',
    checkpoint: 'launch',
    message: (s) => `Contacting ${s.participants.length} people…`,
    apply: (s) => {
      s.status = 'CONTACTING';
    },
  });

  people.forEach((person, i) => {
    steps.push({
      delay: i === 0 ? 900 : 420,
      type: 'message.sent',
      checkpoint: i === people.length - 1 ? 'texted' : undefined,
      message: () => `Texted ${person.name} — ${session.hostName} wants the group in`,
      apply: (s) => {
        const p = s.participants.find((x) => x.id === person.id);
        if (p) p.status = 'TEXTED';
        if (i === people.length - 1) s.status = 'COLLECTING';
      },
    });
  });

  people.forEach((person, i) => {
    steps.push({
      delay: i === 0 ? 1900 : 950,
      type: 'call.requested',
      checkpoint: i === people.length - 1 ? 'calling' : undefined,
      message: () => `Calling ${person.name}…`,
      apply: (s) => {
        const p = s.participants.find((x) => x.id === person.id);
        if (p) p.status = 'CALLING';
      },
    });
  });

  others.forEach((person, i) => {
    steps.push({
      delay: i === 0 ? 1300 : 1500,
      type: 'call.started',
      message: () => `${person.name} answered`,
      apply: (s) => {
        const p = s.participants.find((x) => x.id === person.id);
        if (p) p.status = 'IN_CALL';
      },
    });
  });

  steps.push({
    delay: 2100,
    type: 'call.failed',
    message: () => `${blocker.name} didn't pick up — falling back to text`,
    apply: (s) => {
      const p = s.participants.find((x) => x.id === blocker.id);
      if (p) p.status = 'NEEDS_FOLLOWUP';
    },
  });
  steps.push({
    delay: 700,
    type: 'message.sent',
    message: () => `Asked ${blocker.name} by text: when are you free this weekend?`,
  });

  others.forEach((person, i) => {
    steps.push({
      delay: i === 0 ? 2600 : 2100,
      type: 'preferences.received',
      checkpoint: i === others.length - 1 ? 'collecting' : undefined,
      message: () => `${person.name}'s availability received`,
      apply: (s) => {
        const p = s.participants.find((x) => x.id === person.id);
        if (p) {
          p.preferences = prefsFor(s, p);
          p.status = 'RESPONDED';
        }
      },
    });
  });

  steps.push({
    delay: 2600,
    type: 'message.received',
    message: () => `${blocker.name} replied by text`,
  });
  steps.push({
    delay: 900,
    type: 'preferences.received',
    message: () => `${blocker.name}'s availability received`,
    apply: (s) => {
      const p = s.participants.find((x) => x.id === blocker.id);
      if (p) {
        p.preferences = BLOCKER_PREFS;
        p.status = 'RESPONDED';
      }
    },
  });
  steps.push({
    delay: 1100,
    type: 'matching.started',
    message: () => 'Checking viable showtimes…',
    apply: (s) => {
      s.status = 'MATCHING';
    },
  });
  steps.push({
    delay: 1700,
    type: 'conflict.detected',
    checkpoint: 'conflict',
    message: () => 'One availability conflict detected',
    apply: (s) => {
      s.status = 'RESOLVING';
      const p = s.participants.find((x) => x.id === blocker.id);
      if (p) p.status = 'NEEDS_FOLLOWUP';
    },
  });
  steps.push({
    delay: 1300,
    type: 'flexibility.requested',
    checkpoint: 'resolving',
    message: () => `Asking ${blocker.name} if Friday could work`,
  });
  steps.push({
    delay: 5200,
    type: 'message.received',
    message: () => `${blocker.name} replied — Friday works`,
  });
  steps.push({
    delay: 800,
    type: 'conflict.resolved',
    message: () => 'Conflict resolved',
    apply: (s) => {
      const p = s.participants.find((x) => x.id === blocker.id);
      if (p) {
        p.preferences = BLOCKER_RESOLVED_PREFS;
        p.status = 'RESPONDED';
      }
    },
  });
  steps.push({
    delay: 1300,
    type: 'plan.proposed',
    checkpoint: 'proposal',
    message: () => `Badger found ${winner.time} at ${winner.theater}`,
    apply: (s) => {
      s.status = 'PROPOSING';
      s.selectedCandidateId = winner.id;
      s.participants.forEach((p) => {
        p.status = 'PROPOSED';
      });
    },
  });

  [...others, blocker].forEach((person, i) => {
    const isLast = person.id === blocker.id;
    steps.push({
      delay: i === 0 ? 2400 : isLast ? 3600 : 1500,
      type: 'proposal.confirmed',
      message: () => `${person.name} confirmed`,
      apply: (s) => {
        const p = s.participants.find((x) => x.id === person.id);
        if (p) p.status = 'CONFIRMED';
      },
    });
  });

  steps.push({
    delay: 900,
    type: 'plan.committed',
    checkpoint: 'committed',
    message: (s) => `${s.participants.length}/${s.participants.length} committed`,
    apply: (s) => {
      s.status = 'COMMITTED';
    },
  });
  steps.push({
    delay: 700,
    type: 'message.sent',
    message: () => 'Confirmation texts sent to everyone',
  });

  return steps;
}
