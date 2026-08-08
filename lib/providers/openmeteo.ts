import { ApiError } from "../http.js";
import { callUpstream } from "../upstream.js";

/**
 * Open-Meteo ERA5 archive — hourly precipitation.
 *
 * NOAA has no usable hourly source (GHCND is daily; CDO's PRECIP_HLY ends in
 * 2014), so this is what feeds rainhedge's elasticity engine. No API key.
 *
 * Timestamps are requested in GMT and stored in UTC. Asking for `timezone=auto`
 * would return local times plus a single `utc_offset_seconds`, which is wrong
 * for any range spanning a DST transition — one offset cannot describe both
 * sides of it. Local rendering happens on the way out instead, from the IANA
 * zone name, which handles the transition correctly.
 */

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

/** ERA5 lags real time; anything inside this window comes back empty. */
export const ARCHIVE_LAG_DAYS = 6;

export interface HourlyObservation {
  observed_at_utc: string;
  precip_inches: number;
}

interface ArchiveResponse {
  error?: boolean;
  reason?: string;
  timezone?: string;
  hourly?: { time?: string[]; precipitation?: (number | null)[] };
}

async function getArchive(
  params: URLSearchParams,
  client: string,
): Promise<ArchiveResponse> {
  const response = await callUpstream("open-meteo", client, () =>
    fetch(`${ARCHIVE_URL}?${params.toString()}`, { headers: { accept: "application/json" } }),
  );

  const text = await response.text();
  let body: ArchiveResponse;
  try {
    body = JSON.parse(text) as ArchiveResponse;
  } catch {
    throw new ApiError(502, "open_meteo_bad_json", text.slice(0, 200));
  }

  if (body.error) {
    // Open-Meteo reports its own errors in the body with a 400.
    throw new ApiError(502, "open_meteo_error", body.reason ?? "unknown");
  }
  if (!response.ok) {
    throw new ApiError(502, "open_meteo_error", { status: response.status });
  }
  return body;
}

/**
 * Open-Meteo emits '2026-07-01T00:00' with no zone marker. It is GMT because
 * that is what we asked for, so stamp it explicitly rather than let anything
 * downstream guess.
 */
export function toUtcIso(time: string): string {
  if (time.endsWith("Z")) return time;
  const withSeconds = /T\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
  return `${withSeconds}Z`;
}

/** Pairs the parallel time/precipitation arrays, dropping nulls. */
export function normalizeHourly(hourly: ArchiveResponse["hourly"]): HourlyObservation[] {
  const times = hourly?.time ?? [];
  const values = hourly?.precipitation ?? [];

  const observations: HourlyObservation[] = [];
  for (const [index, time] of times.entries()) {
    const value = values[index];
    // null means ERA5 has no value for that hour — a hole, not a dry hour.
    if (value === null || value === undefined || !Number.isFinite(value)) continue;

    observations.push({ observed_at_utc: toUtcIso(time), precip_inches: value });
  }
  return observations;
}

export async function fetchHourly(
  lat: number,
  lon: number,
  start: string,
  end: string,
  client: string,
): Promise<HourlyObservation[]> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: start,
    end_date: end,
    hourly: "precipitation",
    precipitation_unit: "inch",
    timezone: "GMT",
  });
  const body = await getArchive(params, client);
  return normalizeHourly(body.hourly);
}

/**
 * The IANA zone name for a point, via a deliberately tiny archive request.
 * Called once per location and cached in location_timezone.
 */
export async function fetchTimezone(
  lat: number,
  lon: number,
  client: string,
): Promise<string> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: "2026-01-01",
    end_date: "2026-01-01",
    hourly: "precipitation",
    timezone: "auto",
  });
  const body = await getArchive(params, client);
  return body.timezone ?? "UTC";
}
