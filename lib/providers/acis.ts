import { ApiError } from "../http.js";
import { haversineMiles } from "../stations.js";
import { callUpstream } from "../upstream.js";
import type { DailyObservation } from "./cdo.js";

/**
 * ACIS (Applied Climate Information System) — the fallback daily source.
 *
 * No API key, no published rate limit, and it blends the regional climate
 * centers' station networks, so it often has coverage where a ZIP returns
 * nothing from CDO. Queried by bounding box around the ZCTA centroid: ACIS's
 * ZIP-as-station-id support is inconsistent, whereas bbox is well specified.
 *
 * Values arrive as strings with sentinels: 'M' is missing and 'T' is a trace —
 * measurable rain below the 0.01" resolution, which is conventionally recorded
 * as zero rather than discarded.
 */

const MULTI_STN_URL = "https://data.rcc-acis.org/MultiStnData";
const MM_PER_INCH = 25.4;
/** Roughly 0.25° ≈ 17 miles — the search box, deliberately wider than the keep radius. */
const BBOX_DEGREES = 0.25;
/** Matches the CDO fallback's radius so both paths answer the same question. */
const KEEP_RADIUS_MI = 15;
/** Matches MAX_STATIONS in stations.ts. */
const KEEP_STATIONS = 5;

interface AcisResponse {
  error?: string;
  data?: {
    meta?: { sids?: string[]; name?: string; ll?: [number, number] };
    data?: string[][];
  }[];
}

/**
 * ACIS precipitation values are strings. Returns null for anything that is not
 * a real measurement, so the caller records a gap rather than a fabricated zero.
 */
export function parseAcisValue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === "" || value === "M" || value === "S") return null;
  // 'T' is a trace: rain fell, but less than the 0.01" the gauge can resolve.
  if (value === "T") return 0;

  const parsed = Number(value.replace(/A$/, "")); // 'A' marks an accumulated total.
  return Number.isFinite(parsed) ? parsed : null;
}

/** Station id for storage. ACIS sids are bare; namespace them to avoid collision with GHCND. */
function stationId(sids: string[] | undefined): string {
  const first = sids?.[0]?.split(" ")[0];
  return `ACIS:${first ?? "unknown"}`;
}

/**
 * Keeps only the stations nearest the centroid.
 *
 * A bbox search returns everything in a ~17-mile square, and averaging all of it
 * answers a different question than CDO's ZIP lookup does — measured live, the
 * full-box mean ran 80% above the ZIP's own gauge on the same day. Narrowing to
 * the same radius and station count as the CDO fallback keeps the two paths
 * comparable, which matters when the number settles a contract.
 *
 * Stations without coordinates are dropped rather than assumed nearby.
 */
export function nearestStations<T extends { meta?: { ll?: [number, number] } }>(
  stations: T[],
  centroid: { lat: number; lon: number },
): T[] {
  return stations
    .flatMap((station) => {
      const ll = station.meta?.ll;
      if (!ll || ll.length !== 2) return [];
      const [lon, lat] = ll; // ACIS reports [lon, lat].
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

      const distance = haversineMiles(centroid, { lat, lon });
      return distance <= KEEP_RADIUS_MI ? [{ station, distance }] : [];
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, KEEP_STATIONS)
    .map((entry) => entry.station);
}

export function normalizeAcis(
  body: AcisResponse,
  days: string[],
  centroid?: { lat: number; lon: number },
): DailyObservation[] {
  const observations: DailyObservation[] = [];
  const stations = centroid ? nearestStations(body.data ?? [], centroid) : (body.data ?? []);

  for (const station of stations) {
    const id = stationId(station.meta?.sids);
    // Rows are aligned to the requested date range, one entry per day.
    for (const [index, day] of days.entries()) {
      const inches = parseAcisValue(station.data?.[index]?.[0]);
      if (inches === null) continue;

      observations.push({
        observation_date: day,
        station_id: id,
        precip_inches: inches,
        precip_mm: Number((inches * MM_PER_INCH).toFixed(2)),
        quality_flag: null,
      });
    }
  }
  return observations;
}

export async function fetchDailyByBbox(
  centroid: { lat: number; lon: number },
  start: string,
  end: string,
  days: string[],
  client: string,
): Promise<DailyObservation[]> {
  const bbox = [
    centroid.lon - BBOX_DEGREES,
    centroid.lat - BBOX_DEGREES,
    centroid.lon + BBOX_DEGREES,
    centroid.lat + BBOX_DEGREES,
  ].join(",");

  const response = await callUpstream("acis", client, () =>
    fetch(MULTI_STN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        bbox,
        sdate: start,
        edate: end,
        elems: [{ name: "pcpn", interval: "dly" }],
        meta: ["name", "sids", "ll"],
      }),
    }),
  );

  if (!response.ok) {
    throw new ApiError(502, "acis_error", { status: response.status });
  }

  const body = (await response.json()) as AcisResponse;
  if (body.error) {
    throw new ApiError(502, "acis_error", body.error);
  }

  return normalizeAcis(body, days, centroid);
}
