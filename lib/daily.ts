import { db } from "./db.js";
import { eachDay, settledCutoff } from "./dates.js";
import {
  CDO_LAG_DAYS,
  fetchDailyByStations,
  fetchDailyByZip,
  type DailyObservation,
} from "./providers/cdo.js";
import { resolveStations } from "./stations.js";

/**
 * Read-through daily precipitation.
 *
 * The cache is authoritative for any day we've already asked about — see
 * daily_coverage in migration 002. Steady state is zero upstream calls; a
 * request only reaches NOAA for days we have never fetched, or for days still
 * inside the reporting lag.
 */

export interface DailyRecord {
  date: string;
  station: string;
  precip_inches: number;
  precip_mm: number;
  quality_flag: string | null;
  settled: boolean;
}

export interface DailyAggregate {
  date: string;
  precip_inches: number;
  station_count: number;
}

/** Collapses a sorted day list into contiguous ranges, so N days cost far fewer calls. */
export function contiguousRanges(days: string[]): { start: string; end: string }[] {
  if (days.length === 0) return [];
  const sorted = [...days].sort();

  const ranges: { start: string; end: string }[] = [];
  let start = sorted[0] as string;
  let previous = start;

  for (const day of sorted.slice(1)) {
    const gap = Date.parse(`${day}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`);
    if (gap > 86_400_000) {
      ranges.push({ start, end: previous });
      start = day;
    }
    previous = day;
  }
  ranges.push({ start, end: previous });
  return ranges;
}

/** Mean across reporting stations. Weighting is a later refinement (ARCHITECTURE §3). */
export function aggregateByDate(records: DailyRecord[]): DailyAggregate[] {
  const byDate = new Map<string, number[]>();
  for (const record of records) {
    const bucket = byDate.get(record.date);
    if (bucket) bucket.push(record.precip_inches);
    else byDate.set(record.date, [record.precip_inches]);
  }

  return [...byDate.entries()]
    .map(([date, values]) => ({
      date,
      precip_inches: Number(
        (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3),
      ),
      station_count: values.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Days in the range we must fetch: never asked, or asked while still unsettled. */
export function missingDays(
  range: string[],
  coverage: { observation_date: string; settled: boolean }[],
): string[] {
  const settledDays = new Set(
    coverage.filter((row) => row.settled).map((row) => row.observation_date),
  );
  return range.filter((day) => !settledDays.has(day));
}

async function loadCoverage(
  zip: string,
  start: string,
  end: string,
): Promise<{ observation_date: string; settled: boolean }[]> {
  const sql = db();
  return (await sql.query(
    `SELECT observation_date::text AS observation_date, settled
       FROM daily_coverage
      WHERE zip = $1 AND observation_date BETWEEN $2 AND $3`,
    [zip, start, end],
  )) as { observation_date: string; settled: boolean }[];
}

async function loadRecords(zip: string, start: string, end: string): Promise<DailyRecord[]> {
  const sql = db();
  const rows = (await sql.query(
    `SELECT observation_date::text AS date,
            station_id AS station,
            precip_inches::float8 AS precip_inches,
            precip_mm::float8 AS precip_mm,
            quality_flag,
            settled
       FROM daily_precip
      WHERE zip = $1 AND observation_date BETWEEN $2 AND $3
      ORDER BY observation_date, station_id`,
    [zip, start, end],
  )) as DailyRecord[];
  return rows;
}

async function persist(
  zip: string,
  observations: DailyObservation[],
  fetchedDays: string[],
  cutoff: string,
): Promise<void> {
  const sql = db();

  if (observations.length > 0) {
    await sql.query(
      `INSERT INTO daily_precip
         (zip, observation_date, station_id, precip_inches, precip_mm, quality_flag, source, settled)
       SELECT $1, d, s, i, m, q, 'cdo', d <= $7::date
         FROM UNNEST($2::date[], $3::varchar[], $4::numeric[], $5::numeric[], $6::varchar[])
              AS t(d, s, i, m, q)
       ON CONFLICT (zip, observation_date, station_id) DO UPDATE
         SET precip_inches = EXCLUDED.precip_inches,
             precip_mm     = EXCLUDED.precip_mm,
             quality_flag  = EXCLUDED.quality_flag,
             settled       = EXCLUDED.settled,
             fetched_at    = now()`,
      [
        zip,
        observations.map((o) => o.observation_date),
        observations.map((o) => o.station_id),
        observations.map((o) => o.precip_inches),
        observations.map((o) => o.precip_mm),
        observations.map((o) => o.quality_flag),
        cutoff,
      ],
    );
  }

  if (fetchedDays.length === 0) return;

  // Mark every day we asked about, including the empty ones — that is the whole
  // point of the coverage table.
  const daysWithData = new Set(observations.map((o) => o.observation_date));
  await sql.query(
    `INSERT INTO daily_coverage (zip, observation_date, source, has_data, settled)
     SELECT $1, d, 'cdo', h, d <= $4::date
       FROM UNNEST($2::date[], $3::boolean[]) AS t(d, h)
     ON CONFLICT (zip, observation_date) DO UPDATE
       SET has_data   = EXCLUDED.has_data,
           settled    = EXCLUDED.settled,
           fetched_at = now()`,
    [zip, fetchedDays, fetchedDays.map((day) => daysWithData.has(day)), cutoff],
  );
}

export interface DailyResult {
  records: DailyRecord[];
  aggregate: DailyAggregate[];
  coverage: { expected_days: number; present_days: number; pct: number };
  meta: { source: string; cache: "hit" | "partial" | "miss"; upstream_calls: number };
  stations: { id: string; distance_mi: number }[];
  fully_settled: boolean;
}

export async function getDaily(
  zip: string,
  start: string,
  end: string,
  client: string,
): Promise<DailyResult> {
  const cutoff = settledCutoff(CDO_LAG_DAYS);
  const range = eachDay(start, end);

  const coverage = await loadCoverage(zip, start, end);
  const gaps = missingDays(range, coverage);
  const ranges = contiguousRanges(gaps);

  let upstreamCalls = 0;
  let stations: { id: string; distance_mi: number }[] = [];

  for (const window of ranges) {
    let observations = await fetchDailyByZip(zip, window.start, window.end, client);
    upstreamCalls += 1;

    // A ZIP with no CDO station coverage returns nothing at all. Fall back to
    // the centroid bounding-box search before concluding "no rain".
    if (observations.length === 0) {
      const resolved = await resolveStations(zip, client);
      upstreamCalls += 1;
      stations = resolved.map((s) => ({ id: s.station_id, distance_mi: s.distance_mi }));

      if (resolved.length > 0) {
        observations = await fetchDailyByStations(
          resolved.map((s) => s.station_id),
          window.start,
          window.end,
          client,
        );
        upstreamCalls += 1;
      }
    }

    await persist(zip, observations, eachDay(window.start, window.end), cutoff);
  }

  const records = await loadRecords(zip, start, end);
  const aggregate = aggregateByDate(records);
  const presentDays = aggregate.length;

  return {
    records,
    aggregate,
    coverage: {
      expected_days: range.length,
      present_days: presentDays,
      pct: range.length === 0 ? 0 : Number((presentDays / range.length).toFixed(4)),
    },
    meta: {
      source: "cdo",
      cache: gaps.length === 0 ? "hit" : gaps.length === range.length ? "miss" : "partial",
      upstream_calls: upstreamCalls,
    },
    stations,
    fully_settled: end <= cutoff,
  };
}
