import type { Participant, Preferences, Session } from '../shared/types.js';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

function candidateMinutes(time: string): number | undefined {
  const match = time.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (match[3]!.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (match[3]!.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function mentionedDays(text: string): Set<string> {
  if (/\bfriday\s+(?:through|thru|to|-)\s+sunday\b/.test(text)) {
    return new Set(['friday', 'saturday', 'sunday']);
  }
  if (/\b(?:all|whole)\s+weekend\b/.test(text)) return new Set(['saturday', 'sunday']);
  return new Set(DAYS.filter((day) => text.includes(day)));
}

function matchesTime(text: string, time: string): boolean {
  const minutes = candidateMinutes(time);
  if (minutes === undefined) return true;
  if (/\bmorning\b/.test(text)) return minutes < 12 * 60;
  if (/\bafternoon\b/.test(text)) return minutes >= 12 * 60 && minutes < 17 * 60;
  if (/\b(?:evening|night)\b/.test(text)) return minutes >= 17 * 60;
  const after = text.match(/\bafter\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (after) {
    let hour = Number(after[1]);
    const minute = Number(after[2] ?? 0);
    const meridiem = after[3]?.toLowerCase();
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    else if (meridiem === 'am' && hour === 12) hour = 0;
    else if (!meridiem && hour <= 11) hour += 12;
    return minutes >= hour * 60 + minute;
  }
  const before = text.match(/\bbefore\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (before) {
    let hour = Number(before[1]);
    const minute = Number(before[2] ?? 0);
    const meridiem = before[3]?.toLowerCase();
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    else if (meridiem === 'am' && hour === 12) hour = 0;
    else if (!meridiem && hour <= 11) hour += 12;
    return minutes <= hour * 60 + minute;
  }
  return true;
}

export function inferPreferencesFromText(
  session: Session,
  participant: Participant,
  message: string,
): Preferences | undefined {
  const text = message.trim().toLowerCase().replaceAll('_', ' ');
  if (!text) return undefined;
  const broad = /\b(?:all day|anytime|any time|whenever)\b/.test(text);
  const days = mentionedDays(text);
  const candidates = session.candidates.filter((candidate) => {
    const day = DAYS.find((item) => candidate.slot.toLowerCase().includes(item));
    if (broad && days.size === 0) return true;
    if (!day || !days.has(day)) return false;
    return broad || matchesTime(text, candidate.time);
  });
  if (!candidates.length) return undefined;

  const matchedSlots = [...new Set(candidates.map((candidate) => candidate.slot))];
  const negative = /\b(?:cannot|can't|cant|unavailable|not available|doesn't work|does not work|won't work)\b/.test(text);
  const previous = participant.preferences;
  const availability = negative
    ? [...(previous?.availability ?? [])]
    : [...new Set([...(previous?.availability ?? []), ...matchedSlots])];
  const hardVetoes = negative
    ? [...new Set([...(previous?.hardVetoes ?? []), ...matchedSlots])]
    : (previous?.hardVetoes ?? []).filter((slot) => !matchedSlots.includes(slot));
  const keywordPreferences = ['imax', '70mm', 'standard', 'amc', 'regal', 'alamo', 'cheap', 'cheapest']
    .filter((keyword) => text.includes(keyword));

  return {
    availability,
    hardVetoes,
    preferences: [...new Set([...(previous?.preferences ?? []), ...keywordPreferences])],
    flexibility: broad || /\bflexible\b/.test(text) ? 1 : negative || /\bonly\b/.test(text) ? 0.2 : previous?.flexibility ?? 0.7,
    summary: previous ? `${previous.summary} Follow-up: ${message.trim()}` : message.trim(),
  };
}
