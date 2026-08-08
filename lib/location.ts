import { db } from "./db.js";
import { ApiError } from "./http.js";
import { fetchTimezone } from "./providers/openmeteo.js";
import { getCentroid } from "./stations.js";

/**
 * Resolving a request to a point on the earth plus a cache key.
 *
 * Hourly data is gridded, so it is addressed by coordinates rather than by
 * station. A ZIP is just one way of naming a point; rainhedge names sites by
 * lat/lon directly.
 */

export interface ResolvedLocation {
  key: string;
  lat: number;
  lon: number;
  zip: string | null;
}

/** 4dp ≈ 11m, comfortably finer than the ERA5 grid and stable as a cache key. */
export function geoKey(lat: number, lon: number): string {
  return `geo:${lat.toFixed(4)},${lon.toFixed(4)}`;
}

export function zipKey(zip: string): string {
  return `zip:${zip}`;
}

/**
 * Accepts either `zip` or `lat`+`lon`. A ZIP resolves through the ZCTA centroid,
 * so it inherits the ZCTA coverage gap: PO-box-only ZIPs have no centroid and
 * fail loudly rather than silently returning nothing.
 */
export async function resolveLocation(params: URLSearchParams): Promise<ResolvedLocation> {
  const zip = params.get("zip")?.trim();
  const latRaw = params.get("lat");
  const lonRaw = params.get("lon");

  if (zip) {
    if (!/^\d{5}$/.test(zip)) {
      throw new ApiError(400, "invalid_zip", "zip must be 5 digits");
    }
    const centroid = await getCentroid(zip);
    if (!centroid) {
      throw new ApiError(422, "no_centroid_for_zip", {
        zip,
        reason:
          "ZIP has no ZCTA centroid (PO-box-only or single-org ZIPs have no tabulation area). " +
          "Pass lat and lon instead.",
      });
    }
    return { key: zipKey(zip), lat: centroid.lat, lon: centroid.lon, zip };
  }

  if (latRaw !== null || lonRaw !== null) {
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new ApiError(400, "invalid_lat", "lat must be a number between -90 and 90");
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new ApiError(400, "invalid_lon", "lon must be a number between -180 and 180");
    }
    return { key: geoKey(lat, lon), lat, lon, zip: null };
  }

  throw new ApiError(400, "missing_location", "provide either zip, or lat and lon");
}

/** Whether the zone is already known, so callers can attribute the lookup's cost. */
export async function timezoneIsCached(key: string): Promise<boolean> {
  const sql = db();
  const rows = (await sql.query(
    `SELECT 1 FROM location_timezone WHERE location_key = $1`,
    [key],
  )) as unknown[];
  return rows.length > 0;
}

/** IANA zone for a location, learned once from Open-Meteo then cached forever. */
export async function resolveTimezone(
  location: ResolvedLocation,
  client: string,
): Promise<string> {
  const sql = db();
  const cached = (await sql.query(
    `SELECT timezone FROM location_timezone WHERE location_key = $1`,
    [location.key],
  )) as { timezone: string }[];

  const hit = cached[0]?.timezone;
  if (hit) return hit;

  const timezone = await fetchTimezone(location.lat, location.lon, client);
  await sql.query(
    `INSERT INTO location_timezone (location_key, timezone) VALUES ($1, $2)
     ON CONFLICT (location_key) DO UPDATE SET timezone = EXCLUDED.timezone`,
    [location.key, timezone],
  );
  return timezone;
}

/**
 * Renders a UTC instant as a naive local timestamp ('YYYY-MM-DDTHH:mm:ss').
 *
 * Uses Intl rather than a fixed offset so DST transitions land correctly — the
 * whole reason storage is UTC. 'en-CA' is chosen for its ISO-shaped date order.
 */
export function toLocalNaive(utcIso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcIso));

  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  // Intl renders midnight as '24' in some environments; normalise it.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function offsetMsAt(instant: Date, timezone: string): number {
  const wallClock = new Date(`${toLocalNaive(instant.toISOString(), timezone)}Z`);
  return wallClock.getTime() - instant.getTime();
}

/**
 * The UTC instant of local midnight starting `day`.
 *
 * Applied twice: the first pass uses the offset at UTC midnight, which is the
 * wrong side of a transition when the change falls between the two, and the
 * second pass corrects using the offset at the candidate instant.
 */
export function localMidnightUtc(day: string, timezone: string): Date {
  const utcMidnight = new Date(`${day}T00:00:00Z`);
  const firstPass = new Date(utcMidnight.getTime() - offsetMsAt(utcMidnight, timezone));
  return new Date(utcMidnight.getTime() - offsetMsAt(firstPass, timezone));
}

/**
 * How many hours a local date range actually contains.
 *
 * Not simply `days * 24`: the spring-forward day has 23 and the fall-back day
 * has 25. Reporting 24 would make a complete series look like it had a hole.
 */
export function localHoursInRange(start: string, endInclusive: string, timezone: string): number {
  const from = localMidnightUtc(start, timezone);
  const to = localMidnightUtc(addOneDay(endInclusive), timezone);
  return Math.round((to.getTime() - from.getTime()) / 3_600_000);
}

function addOneDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
