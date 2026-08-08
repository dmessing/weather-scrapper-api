import { requireNoaaToken } from "../env.js";
import { ApiError } from "../http.js";
import { callUpstream } from "../upstream.js";

/**
 * NOAA Climate Data Online v2 — GHCND daily precipitation.
 *
 * Two quirks drive the shape of this module:
 *  - CDO caps a single request at 1000 records and one year of dates, so both
 *    pagination and range validation live here rather than at the route.
 *  - An empty result set comes back as `{}` with no `results` key at all, not
 *    as an empty array.
 */

const BASE_URL = "https://www.ncdc.noaa.gov/cdo-web/api/v2";
const PAGE_SIZE = 1000;
const MAX_PAGES = 25;
const MM_PER_INCH = 25.4;

/** GHCND observations settle within a couple of days; 3 is the safe margin. */
export const CDO_LAG_DAYS = 3;
/** CDO rejects a data request spanning more than one year. */
export const CDO_MAX_RANGE_DAYS = 366;

export interface CdoResult {
  date: string;
  datatype: string;
  station: string;
  attributes?: string;
  value: number;
}

export interface DailyObservation {
  observation_date: string;
  station_id: string;
  precip_inches: number;
  precip_mm: number;
  quality_flag: string | null;
}

interface CdoPage {
  metadata?: { resultset?: { offset: number; count: number; limit: number } };
  results?: CdoResult[];
}

/**
 * GHCND packs four flags into `attributes` as "fl_m,fl_q,fl_so,fl_t".
 * A non-empty quality flag means the observation failed NOAA's own QC.
 */
export function qualityFlag(attributes: string | undefined): string | null {
  const flag = attributes?.split(",")[1]?.trim();
  return flag ? flag : null;
}

/** Converts raw CDO rows into storage shape, dropping QC failures. */
export function normalize(results: CdoResult[]): DailyObservation[] {
  const observations: DailyObservation[] = [];
  for (const result of results) {
    if (result.datatype !== "PRCP") continue;
    if (!Number.isFinite(result.value)) continue;

    // A failed QC check is worse than a missing day: it is a wrong number that
    // looks real. Drop it and let coverage reporting show the hole.
    const flag = qualityFlag(result.attributes);
    if (flag) continue;

    observations.push({
      observation_date: result.date.slice(0, 10),
      station_id: result.station,
      // units=standard already yields inches for PRCP.
      precip_inches: result.value,
      precip_mm: Number((result.value * MM_PER_INCH).toFixed(2)),
      quality_flag: null,
    });
  }
  return observations;
}

async function getPage(
  path: string,
  params: URLSearchParams,
  client: string,
): Promise<CdoPage> {
  const token = requireNoaaToken();
  const url = `${BASE_URL}${path}?${params.toString()}`;

  const response = await callUpstream("cdo", client, () =>
    // CDO wants the key in a bare `token` header, not Authorization.
    fetch(url, { headers: { token, accept: "application/json" } }),
  );

  if (response.status === 400) {
    throw new ApiError(400, "cdo_rejected_request", await response.text());
  }
  if (!response.ok) {
    throw new ApiError(502, "cdo_error", {
      status: response.status,
      body: (await response.text()).slice(0, 400),
    });
  }

  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as CdoPage;
  } catch {
    throw new ApiError(502, "cdo_bad_json", text.slice(0, 200));
  }
}

/** Walks CDO's offset pagination until the reported count is exhausted. */
async function paginate(
  path: string,
  base: URLSearchParams,
  client: string,
): Promise<CdoResult[]> {
  const collected: CdoResult[] = [];
  let offset = 1; // CDO's offset is 1-based.

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams(base);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));

    const body = await getPage(path, params, client);
    const results = body.results ?? [];
    collected.push(...results);

    const total = body.metadata?.resultset?.count ?? collected.length;
    offset += results.length;
    if (results.length === 0 || collected.length >= total) break;
  }

  return collected;
}

/** Daily PRCP for a ZIP over an inclusive date range. */
export async function fetchDailyByZip(
  zip: string,
  start: string,
  end: string,
  client: string,
): Promise<DailyObservation[]> {
  const params = new URLSearchParams({
    datasetid: "GHCND",
    datatypeid: "PRCP",
    locationid: `ZIP:${zip}`,
    startdate: start,
    enddate: end,
    units: "standard",
  });
  return normalize(await paginate("/data", params, client));
}

/** Same, but for an explicit station list — the centroid fallback path. */
export async function fetchDailyByStations(
  stationIds: string[],
  start: string,
  end: string,
  client: string,
): Promise<DailyObservation[]> {
  if (stationIds.length === 0) return [];
  const params = new URLSearchParams({
    datasetid: "GHCND",
    datatypeid: "PRCP",
    startdate: start,
    enddate: end,
    units: "standard",
  });
  for (const id of stationIds) params.append("stationid", id);
  return normalize(await paginate("/data", params, client));
}

export interface CdoStation {
  id: string;
  name?: string;
  latitude: number;
  longitude: number;
}

/** Active PRCP-reporting stations inside a bounding box. */
export async function fetchStationsInExtent(
  extent: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  client: string,
): Promise<CdoStation[]> {
  const params = new URLSearchParams({
    datasetid: "GHCND",
    datatypeid: "PRCP",
    extent: `${extent.minLat},${extent.minLon},${extent.maxLat},${extent.maxLon}`,
  });
  const page = await getPage(
    "/stations",
    new URLSearchParams({ ...Object.fromEntries(params), limit: String(PAGE_SIZE) }),
    client,
  );
  return ((page as { results?: CdoStation[] }).results ?? []).filter(
    (station) => Number.isFinite(station.latitude) && Number.isFinite(station.longitude),
  );
}
