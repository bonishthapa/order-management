/**
 * Bikram Sambat <-> Gregorian conversion.
 *
 * Uses bs-calendar.json, which is byte-identical to the backend's copy (see
 * scripts/sync-calendar-data.mjs). The algorithm is the same day count from the
 * anchor 1975-01-01 BS = 1918-04-13 AD as apps/calendar_utils/bs.py, so the frontend
 * and backend can never disagree. All AD dates are handled as "YYYY-MM-DD" strings in UTC
 * arithmetic, so the browser's timezone can never shift a business date.
 */
import data from "./bs-calendar.json";

export type ISODate = string; // YYYY-MM-DD (AD)
export interface BSDate {
  year: number;
  month: number;
  day: number;
}

const MS_PER_DAY = 86_400_000;
const months: Record<number, number[]> = Object.fromEntries(
  Object.entries(data.months as Record<string, number[]>).map(([y, m]) => [Number(y), m]),
);
export const BS_MIN_YEAR: number = data.minYear;
export const BS_MAX_YEAR: number = data.maxYear;
export const BS_MONTH_NAMES: string[] = data.monthNames;
export const BS_MONTH_NAMES_NE: string[] = data.monthNamesNe;

const anchorUtc = Date.UTC(data.reference.ad[0], data.reference.ad[1] - 1, data.reference.ad[2]);
const yearOffsets: Record<number, number> = {};
let totalDays = 0;
for (let y = BS_MIN_YEAR; y <= BS_MAX_YEAR; y++) {
  yearOffsets[y] = totalDays;
  totalDays += months[y].reduce((a, b) => a + b, 0);
}

export class BSDateError extends Error {}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function isoToUtc(iso: ISODate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new BSDateError(`'${iso}' is not a date in YYYY-MM-DD format.`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new BSDateError(`${iso} is not a valid date.`);
  }
  return t;
}

export function utcToIso(t: number): ISODate {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function daysInBsMonth(year: number, month: number): number {
  if (!months[year]) throw new BSDateError(`BS year ${year} is outside the supported range ${BS_MIN_YEAR}–${BS_MAX_YEAR}.`);
  if (month < 1 || month > 12) throw new BSDateError(`BS month must be between 1 and 12.`);
  return months[year][month - 1];
}

export function validateBs(b: BSDate): void {
  const len = daysInBsMonth(b.year, b.month);
  if (b.day < 1 || b.day > len) {
    throw new BSDateError(`${b.year}-${pad(b.month)} BS has ${len} days; day ${b.day} is invalid.`);
  }
}

export function bsToAd(b: BSDate): ISODate {
  validateBs(b);
  const days = yearOffsets[b.year] + months[b.year].slice(0, b.month - 1).reduce((a, c) => a + c, 0) + (b.day - 1);
  return utcToIso(anchorUtc + days * MS_PER_DAY);
}

export function adToBs(iso: ISODate): BSDate {
  const offset = Math.round((isoToUtc(iso) - anchorUtc) / MS_PER_DAY);
  if (offset < 0 || offset >= totalDays) throw new BSDateError(`${iso} is outside the supported calendar range.`);
  let year = BS_MIN_YEAR;
  for (let y = BS_MIN_YEAR; y <= BS_MAX_YEAR; y++) {
    if (yearOffsets[y] > offset) break;
    year = y;
  }
  let remaining = offset - yearOffsets[year];
  for (let m = 0; m < 12; m++) {
    const len = months[year][m];
    if (remaining < len) return { year, month: m + 1, day: remaining + 1 };
    remaining -= len;
  }
  throw new BSDateError("unreachable");
}

export function formatBs(b: BSDate): string {
  return `${b.year}-${pad(b.month)}-${pad(b.day)}`;
}

export function parseBs(text: string): BSDate {
  const m = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/.exec(text ?? "");
  if (!m) throw new BSDateError(`'${text}' is not a BS date in YYYY-MM-DD format.`);
  const b = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  validateBs(b);
  return b;
}

export function adToBsString(iso: ISODate | null | undefined): string {
  if (!iso) return "";
  try {
    return formatBs(adToBs(iso.slice(0, 10)));
  } catch {
    return "";
  }
}

export function addDays(iso: ISODate, days: number): ISODate {
  return utcToIso(isoToUtc(iso) + days * MS_PER_DAY);
}

/** Today's business date in a given IANA timezone (default Asia/Kathmandu), not the browser's. */
export function todayIn(timeZone = "Asia/Kathmandu"): ISODate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parts;
}

export function weekdayOf(iso: ISODate): number {
  return new Date(isoToUtc(iso)).getUTCDay();
}

export const supportedRange = { min: utcToIso(anchorUtc), max: utcToIso(anchorUtc + (totalDays - 1) * MS_PER_DAY) };
