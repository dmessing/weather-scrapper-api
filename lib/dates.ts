import { ApiError } from "./http.js";

/**
 * Plain calendar-date helpers. Observation dates carry no time and no zone —
 * treating them as UTC midnight keeps the arithmetic honest and avoids the
 * classic off-by-one where a local-midnight Date shifts a day backwards.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function parseDate(value: string | null, field: string): string {
  if (!value || !DATE_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_date", `${field} must be YYYY-MM-DD`);
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp)) {
    throw new ApiError(400, "invalid_date", `${field} is not a real date`);
  }
  // Round-trip guard: Date.parse accepts 2026-02-31 and silently rolls it over.
  if (toIsoDate(new Date(timestamp)) !== value) {
    throw new ApiError(400, "invalid_date", `${field} is not a real date`);
  }
  return value;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return toIsoDate(new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * MS_PER_DAY));
}

export function daysBetween(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Math.round((to - from) / MS_PER_DAY) + 1;
}

export function eachDay(start: string, end: string): string[] {
  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}

/**
 * The newest date whose observations can be considered final. Anything after
 * this is still inside the provider's reporting lag and gets refetched.
 */
export function settledCutoff(lagDays: number, today = new Date()): string {
  return addDays(toIsoDate(today), -lagDays);
}
