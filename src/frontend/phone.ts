/** Phone input handling: digits only while typing, E.164 for storage, pretty for display. */

export function sanitizePhoneInput(value: string): string {
  const plus = value.trimStart().startsWith('+');
  const digits = value.replace(/\D/g, '').slice(0, 15);
  return (plus ? '+' : '') + digits;
}

/** Returns E.164 (+14155550101) or null when the number is implausible. */
export function normalizePhone(value: string): string | null {
  const s = sanitizePhoneInput(value);
  if (s.startsWith('+')) {
    const digits = s.slice(1);
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (s.length === 10) return `+1${s}`;
  if (s.length === 11 && s.startsWith('1')) return `+${s}`;
  return null;
}

/** (415) 555-0101 for US numbers; E.164 for everything else. */
export function prettyPhone(value: string): string {
  const e164 = normalizePhone(value);
  if (!e164) return value;
  if (e164.startsWith('+1') && e164.length === 12) {
    return `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  }
  return e164;
}
