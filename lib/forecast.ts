import { toLocalNaive } from "./location.js";
import type { ForecastInterval } from "./providers/nws.js";

/**
 * Forecast shaping. Deliberately not persisted (ARCHITECTURE §4.2): a forecast
 * is mutable, so caching it would need snapshot-versioning by issue time to
 * mean anything. It is served live under a short CDN TTL instead.
 */

export interface ForecastDay {
  date: string;
  precip_inches: number;
  max_probability_percent: number | null;
}

/**
 * Rolls interval forecasts up to local calendar days.
 *
 * Precipitation is summed because each interval is a depth over its own window;
 * probability is maxed because chances over adjacent windows are not additive —
 * summing two 40% windows into 80% would be nonsense.
 *
 * An interval straddling local midnight is attributed to the day it starts in.
 * Splitting it proportionally would invent sub-interval structure the forecast
 * does not contain.
 */
export function toDailyForecast(
  precipitation: ForecastInterval[],
  probability: ForecastInterval[],
  timezone: string,
): ForecastDay[] {
  const depthByDay = new Map<string, number>();
  for (const interval of precipitation) {
    const day = toLocalNaive(interval.valid_from, timezone).slice(0, 10);
    depthByDay.set(day, (depthByDay.get(day) ?? 0) + interval.value);
  }

  const chanceByDay = new Map<string, number>();
  for (const interval of probability) {
    const day = toLocalNaive(interval.valid_from, timezone).slice(0, 10);
    chanceByDay.set(day, Math.max(chanceByDay.get(day) ?? 0, interval.value));
  }

  const days = [...new Set([...depthByDay.keys(), ...chanceByDay.keys()])].sort();
  return days.map((date) => ({
    date,
    precip_inches: Number((depthByDay.get(date) ?? 0).toFixed(3)),
    max_probability_percent: chanceByDay.get(date) ?? null,
  }));
}

/**
 * Trims a daily forecast to `days` calendar days starting at `fromDate`.
 *
 * The NWS gridpoint series opens before the current hour, so its first bucket is
 * usually yesterday in local time. Slicing without dropping those would spend
 * part of a "7 day forecast" on days that have already happened.
 */
export function limitDays(
  forecast: ForecastDay[],
  days: number,
  fromDate?: string,
): ForecastDay[] {
  const future = fromDate ? forecast.filter((day) => day.date >= fromDate) : forecast;
  return future.slice(0, Math.max(1, days));
}
