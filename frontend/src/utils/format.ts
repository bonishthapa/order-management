import { adToBsString } from "@/calendar/bs";
import type { DateDisplayMode } from "@/api/types";

/** South-Asian (lakh/crore) or western digit grouping, matching the backend PDFs. */
export function groupDigits(integer: string, style: "lakh" | "thousand"): string {
  if (integer.length <= 3) return integer;
  if (style === "lakh") {
    const tail = integer.slice(-3);
    let head = integer.slice(0, -3);
    const groups: string[] = [];
    while (head.length > 2) {
      groups.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
    if (head) groups.unshift(head);
    return [...groups, tail].join(",");
  }
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

let groupingStyle: "lakh" | "thousand" = "lakh";
export function setNumberLocale(locale: string) {
  groupingStyle = /(NP|IN)$/i.test(locale) ? "lakh" : "thousand";
}

/** Formats a decimal string without going through floating point. */
export function formatAmount(value: string | number | null | undefined, places = 2): string {
  if (value === null || value === undefined || value === "") return "";
  let text = typeof value === "number" ? value.toFixed(places) : String(value);
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  let [integer, fraction = ""] = text.split(".");
  if (fraction.length > places) {
    const fixed = Number(`${integer}.${fraction}`).toFixed(places);
    [integer, fraction = ""] = fixed.split(".");
  }
  fraction = fraction.padEnd(places, "0");
  const grouped = groupDigits(integer.replace(/^0+(?=\d)/, ""), groupingStyle);
  const body = places ? `${grouped}.${fraction}` : grouped;
  return negative && Number(text) !== 0 ? `−${body}` : body;
}

export function formatQty(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  const text = String(value).includes(".") ? String(value).replace(/\.?0+$/, "") : String(value);
  const [integer, fraction] = text.replace("-", "").split(".");
  return `${n < 0 ? "−" : ""}${groupDigits(integer, groupingStyle)}${fraction ? `.${fraction}` : ""}`;
}

export function formatPercent(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return `${Number(value).toFixed(1).replace(/\.0$/, "")}%`;
}

/** Business date in the user's AD/BS display mode. ``bs`` may be supplied by the API. */
export function formatDate(ad: string | null | undefined, mode: DateDisplayMode, bs?: string | null): string {
  if (!ad) return "";
  const iso = ad.slice(0, 10);
  const bsText = bs ?? adToBsString(iso);
  if (mode === "AD" || !bsText) return iso;
  if (mode === "BS") return bsText;
  return `${bsText} · ${iso}`;
}

export function formatDateTime(value: string | null | undefined, timeZone = "Asia/Kathmandu"): string {
  if (!value) return "";
  const d = new Date(value);
  return new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function toNumber(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Round half-up to 2 decimals on cents to mirror the server's ROUND_HALF_UP preview. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/(^|\s)\w/g, (c) => c.toUpperCase());
