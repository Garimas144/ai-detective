// Times in this game are shown to players in 12-hour form ("9:14 PM", "12:30 AM").

/** "21:14" -> "9:14 PM", "00:30" -> "12:30 AM". */
export function to12h(hour24: number, minute: number): string {
  const h = hour24 % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour24 < 12 ? "AM" : "PM"}`;
}

/**
 * Rewrites 24-hour clock times inside free text (model output) to 12-hour form. Only times that are clearly 24-hour
 * are changed: a leading zero ("00:30", "01:05") or an hour from 13 to 23. Times like "9:05" are left alone.
 * Times already followed by AM/PM are left alone.
 */
export function normalizeTimes(text: string): string {
  return text.replace(/\b(0?\d|1[3-9]|2[0-3]):([0-5]\d)\b(?!\s?[AaPp]\.?[Mm])/g, (m, h: string, min: string) => {
    const hour = Number(h);
    const clearly24 = h.length === 2 && h.startsWith("0") ? true : hour >= 13;
    return clearly24 ? to12h(hour, Number(min)) : m;
  });
}

/** Parses "21:05", "9:05 PM" or "12:30 am" into minutes after midnight, or null. */
export function toMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp])?\.?[Mm]?\.?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const suffix = m[3]?.toLowerCase();
  if (suffix === "p" && h < 12) h += 12;
  if (suffix === "a" && h === 12) h = 0;
  return h * 60 + min;
}
