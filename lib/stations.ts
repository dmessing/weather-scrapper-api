import { db } from "./db.js";
import { ApiError } from "./http.js";
import { fetchStationsInExtent } from "./providers/cdo.js";

/**
 * ZIP → station resolution, used only as a fallback: CDO's `locationid=ZIP:#####`
 * normally returns data across a ZIP's stations without any of this. When a ZIP
 * has no CDO station coverage, we fall back to the ZCTA centroid and search a
 * bounding box around it.
 */

const SEARCH_RADIUS_MI = 15;
const MAX_STATIONS = 5;
const EARTH_RADIUS_MI = 3958.8;

export interface Centroid {
  lat: number;
  lon: number;
}

export async function getCentroid(zip: string): Promise<Centroid | null> {
  const sql = db();
  const rows = (await sql.query(
    `SELECT lat::float8 AS lat, lon::float8 AS lon FROM zcta_centroid WHERE zip = $1`,
    [zip],
  )) as { lat: number; lon: number }[];
  return rows[0] ?? null;
}

export function haversineMiles(a: Centroid, b: Centroid): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A degree box roughly `radiusMi` on each side of the centroid. */
export function boundingBox(
  centroid: Centroid,
  radiusMi: number,
): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
  const latDelta = radiusMi / 69;
  // Longitude degrees shrink toward the poles; guard the cosine near them.
  const lonDelta = radiusMi / (69 * Math.max(0.01, Math.cos((centroid.lat * Math.PI) / 180)));
  return {
    minLat: centroid.lat - latDelta,
    minLon: centroid.lon - lonDelta,
    maxLat: centroid.lat + latDelta,
    maxLon: centroid.lon + lonDelta,
  };
}

export interface ResolvedStation {
  station_id: string;
  distance_mi: number;
}

async function cachedStations(zip: string): Promise<ResolvedStation[]> {
  const sql = db();
  return (await sql.query(
    `SELECT station_id, distance_mi::float8 AS distance_mi
       FROM zip_station WHERE zip = $1 ORDER BY distance_mi`,
    [zip],
  )) as ResolvedStation[];
}

/**
 * Nearest PRCP stations to a ZIP, cached in zip_station after the first lookup.
 *
 * Throws 422 rather than guessing when the ZIP has no ZCTA centroid — PO-box-only
 * and single-org ZIPs genuinely have no geography to search from, and a silent
 * empty result would read as "no rain".
 */
export async function resolveStations(
  zip: string,
  client: string,
): Promise<ResolvedStation[]> {
  const cached = await cachedStations(zip);
  if (cached.length > 0) return cached;

  const centroid = await getCentroid(zip);
  if (!centroid) {
    throw new ApiError(422, "no_centroid_for_zip", {
      zip,
      reason:
        "ZIP has no ZCTA centroid (PO-box-only or single-org ZIPs have no tabulation area).",
    });
  }

  const stations = await fetchStationsInExtent(boundingBox(centroid, SEARCH_RADIUS_MI), client);

  const nearby = stations
    .map((station) => ({
      station_id: station.id,
      distance_mi: Number(
        haversineMiles(centroid, { lat: station.latitude, lon: station.longitude }).toFixed(2),
      ),
    }))
    .filter((station) => station.distance_mi <= SEARCH_RADIUS_MI)
    .sort((a, b) => a.distance_mi - b.distance_mi)
    .slice(0, MAX_STATIONS);

  if (nearby.length > 0) {
    const sql = db();
    await sql.query(
      `INSERT INTO zip_station (zip, station_id, distance_mi)
       SELECT $1, * FROM UNNEST($2::varchar[], $3::numeric[])
       ON CONFLICT (zip, station_id) DO UPDATE SET distance_mi = EXCLUDED.distance_mi`,
      [zip, nearby.map((s) => s.station_id), nearby.map((s) => s.distance_mi)],
    );
  }

  return nearby;
}
