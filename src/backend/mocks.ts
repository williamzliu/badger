import type { Candidate } from '../shared/types.js';

/** Controlled demo fixtures, not a live ticketing feed. Reverify showtimes
 * before presenting the demo as current cinema inventory. */
export const mockCandidates: Candidate[] = [
  { id: 'mock_friday_imax', theater: 'AMC Metreon', time: 'Friday 9:20 PM', slot: 'friday_after_8', format: 'IMAX', price: 24, location: 'San Francisco' },
  { id: 'mock_saturday_day', theater: 'Regal Stonestown', time: 'Saturday 2:10 PM', slot: 'saturday_afternoon', format: 'Standard', price: 19, location: 'San Francisco' },
  { id: 'mock_saturday_imax', theater: 'AMC Metreon', time: 'Saturday 8:30 PM', slot: 'saturday_evening', format: 'IMAX', price: 24, location: 'San Francisco' },
  { id: 'mock_sunday_day', theater: 'Alamo Drafthouse New Mission', time: 'Sunday 4:00 PM', slot: 'sunday_afternoon', format: 'Standard', price: 18, location: 'San Francisco' }
];

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
  return [];
}

function activityFromGoal(goal: string): string {
  const dayPattern = DAYS.join('|');
  const withoutSchedule = goal
    .replace(new RegExp(`\\s+(?:on\\s+)?(?:this\\s+|next\\s+)?(?:${dayPattern}|weekend)\\b.*$`, 'i'), '')
    .replace(/^\s*(?:please\s+)?(?:go\s+to|meet\s+at|do|have|schedule|plan)\s+/i, '')
    .trim()
    .replace(/[.,!?]+$/, '');
  return withoutSchedule || goal.trim();
}

/** The original Odyssey demo keeps its verified fixtures. Free-form goals get
 * neutral time windows derived from the day named by the host, so an activity
 * request can never accidentally propose a movie theater. */
export function candidatesForGoal(goal: string): Candidate[] {
  const days = daysFromGoal(goal);
  const isOriginalMovieDemo = /\bodyssey\b/i.test(goal) && /\bweekend\b/i.test(goal);
  if (isOriginalMovieDemo || !days.length) return mockCandidates;

  const activity = activityFromGoal(goal);
  const periods = ['morning', 'afternoon', 'evening'] as const;
  return days.flatMap((day) => periods.map((period) => ({
    id: `goal_${day}_${period}`,
    theater: activity,
    time: `${titleCase(day)} ${period}`,
    slot: `${day}_${period}`,
    format: 'Activity',
    price: 0,
    location: activity,
  })));
}
