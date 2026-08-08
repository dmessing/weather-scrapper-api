import { requireNwsUserAgent } from "../env.js";
import { ApiError } from "../http.js";
import { callUpstream } from "../upstream.js";

/**
 * NWS api.weather.gov — quantitative precipitation forecast.
 *
 * Two-hop API: /points/{lat},{lon} resolves to a gridpoint URL, and the
 * gridpoint carries the actual forecast series. The point lookup is stable per
 * coordinate, so it is cached in module scope for the life of the instance.
 *
 * NWS returns forecast values over *intervals* of varying length — a 6-hour QPF
 * is one value covering six hours, not six hourly values. Those intervals are
 * passed through as-is rather than spread evenly across their hours, which
 * would invent detail the forecast does not contain.
 */

const BASE_URL = "https://api.weather.gov";
const MM_PER_INCH = 25.4;

export interface ForecastInterval {
  valid_from: string;
  valid_to: string;
  hours: number;
  value: number;
}

interface GridpointSeries {
  uom?: string;
  values?: { validTime: string; value: number | null }[];
}

interface GridpointResponse {
  properties?: {
    quantitativePrecipitation?: GridpointSeries;
    probabilityOfPrecipitation?: GridpointSeries;
  };
}

/**
 * Splits an ISO 8601 interval like '2026-08-08T18:00:00+00:00/PT6H' into its
 * start instant and duration in hours.
 */
export function parseValidTime(validTime: string): { start: string; hours: number } | null {
  const [startRaw, duration] = validTime.split("/");
  if (!startRaw || !duration) return null;

  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(duration);
  if (!match) return null;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const totalHours = days * 24 + hours + minutes / 60;
  if (totalHours <= 0) return null;

  const start = new Date(startRaw);
  if (Number.isNaN(start.getTime())) return null;

  return { start: start.toISOString(), hours: totalHours };
}

/** Converts a gridpoint series into intervals, in inches when it is a depth. */
export function normalizeSeries(
  series: GridpointSeries | undefined,
  { convertToInches }: { convertToInches: boolean },
): ForecastInterval[] {
  const values = series?.values ?? [];
  // NWS reports depths in mm ('wmoUnit:mm') and percentages in 'wmoUnit:percent'.
  const isMillimetres = (series?.uom ?? "").includes("mm");

  const intervals: ForecastInterval[] = [];
  for (const entry of values) {
    if (entry.value === null || entry.value === undefined) continue;
    if (!Number.isFinite(entry.value)) continue;

    const parsed = parseValidTime(entry.validTime);
    if (!parsed) continue;

    const value =
      convertToInches && isMillimetres
        ? Number((entry.value / MM_PER_INCH).toFixed(4))
        : entry.value;

    intervals.push({
      valid_from: parsed.start,
      valid_to: new Date(Date.parse(parsed.start) + parsed.hours * 3_600_000).toISOString(),
      hours: parsed.hours,
      value,
    });
  }
  return intervals;
}

async function getJson<T>(url: string, client: string): Promise<T> {
  const response = await callUpstream("nws", client, () =>
    fetch(url, {
      headers: {
        // NWS 403s anything without a contact address here.
        "user-agent": requireNwsUserAgent(),
        accept: "application/geo+json",
      },
    }),
  );

  if (response.status === 404) {
    throw new ApiError(422, "outside_nws_coverage", {
      reason: "api.weather.gov covers the US and its territories only.",
    });
  }
  if (!response.ok) {
    throw new ApiError(502, "nws_error", {
      status: response.status,
      body: (await response.text()).slice(0, 300),
    });
  }
  return (await response.json()) as T;
}

const gridpointCache = new Map<string, string>();

async function resolveGridpoint(lat: number, lon: number, client: string): Promise<string> {
  // NWS asks for at most 4 decimals and redirects otherwise.
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = gridpointCache.get(key);
  if (cached) return cached;

  const body = await getJson<{ properties?: { forecastGridData?: string } }>(
    `${BASE_URL}/points/${key}`,
    client,
  );
  const url = body.properties?.forecastGridData;
  if (!url) {
    throw new ApiError(502, "nws_no_gridpoint", { point: key });
  }

  gridpointCache.set(key, url);
  return url;
}

export interface NwsForecast {
  precipitation: ForecastInterval[];
  probability: ForecastInterval[];
}

export async function fetchForecast(
  lat: number,
  lon: number,
  client: string,
): Promise<NwsForecast> {
  const gridpointUrl = await resolveGridpoint(lat, lon, client);
  const grid = await getJson<GridpointResponse>(gridpointUrl, client);

  return {
    precipitation: normalizeSeries(grid.properties?.quantitativePrecipitation, {
      convertToInches: true,
    }),
    probability: normalizeSeries(grid.properties?.probabilityOfPrecipitation, {
      convertToInches: false,
    }),
  };
}
