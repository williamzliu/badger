import type { Candidate } from './types.js';

const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function daysFromGoal(goal: string): string[] {
  const normalized = goal.toLowerCase();
  const explicit = DAYS.filter((day) => new RegExp(`\\b${day}\\b`).test(normalized));
  if (explicit.length) return [...explicit];
  if (/\bweekend\b/.test(normalized)) return ['saturday', 'sunday'];
  if (/\bweekdays?\b/.test(normalized)) return DAYS.slice(0, 5);
  // With no day in the goal, keep every day available for negotiation. The
  // participants—not a hidden fixture—decide which windows survive.
  return [...DAYS];
}

function activityFromGoal(goal: string): string {
  const dayPattern = DAYS.join('|');
  const withoutSchedule = goal
    .replace(new RegExp(`\\s+(?:on\\s+)?(?:this\\s+|next\\s+)?(?:${dayPattern}|weekend|week)\\b.*$`, 'i'), '')
    .replace(/^\s*(?:please\s+)?(?:go\s+to|meet\s+at|see|watch|do|have|schedule|plan)\s+/i, '')
    .trim()
    .replace(/[.,!?]+$/, '');
  return withoutSchedule || goal.trim();
}

/** Build neutral coordination windows from the host's goal. These are time
 * options, not claims about a venue's inventory, hours, price, or location. */
export function candidatesForGoal(goal: string): Candidate[] {
  const activity = activityFromGoal(goal);
  const periods = ['morning', 'afternoon', 'evening'] as const;
  return daysFromGoal(goal).flatMap((day) => periods.map((period) => ({
    id: `goal_${day}_${period}`,
    theater: activity,
    time: `${titleCase(day)} ${period}`,
    slot: `${day}_${period}`,
    format: 'Activity',
    price: 0,
    location: activity,
  })));
}
