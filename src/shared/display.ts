function dayLabel(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function clockLabel(hour24: number, minute: number): string {
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour = hour24 % 12 || 12;
  return `${hour}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${suffix}`;
}

export function formatCandidateTime(value: string): string {
  const input = value.trim();
  const zoned = input.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (zoned) {
    const date = new Date(input);
    if (!Number.isNaN(date.valueOf())) {
      return `${date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${clockLabel(date.getHours(), date.getMinutes())}`;
    }
  }
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return input;
  let hour = Number(match[4]);
  const minute = Number(match[5] ?? 0);
  const suffix = match[6]?.toUpperCase();
  if (suffix === 'PM' && hour !== 12) hour += 12;
  if (suffix === 'AM' && hour === 12) hour = 0;
  return `${dayLabel(Number(match[1]), Number(match[2]), Number(match[3]))} at ${clockLabel(hour, minute)}`;
}

/** Machine slot tokens ("thursday_evening", "friday_after_8",
 * "every_evening_6_to_10") occasionally leak into user-facing copy via model
 * output or availability echoes. Rewrite them as natural language wherever
 * text is about to reach a person. */
const SLOT_TOKEN =
  /\b(?:every|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|weekday)(?:_[a-z0-9]+)+\b/g;

export function humanizeSlotText(text: string): string {
  return text.replace(SLOT_TOKEN, (token) => {
    const words = token.replaceAll('_', ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  });
}

export function formatCandidateLabel(value: string): string {
  const words = value.trim().replaceAll('_', ' ').replaceAll('-', ' ').replace(/\s+/g, ' ');
  if (!words) return '';
  const natural = words.replace(/\band\b/gi, '&');
  return natural.charAt(0).toUpperCase() + natural.slice(1).toLowerCase();
}
