import { db } from "./db.js";
import { addDays, eachDay, settledCutoff } from "./dates.js";
import { contiguousRanges } from "./daily.js";
import {
  localHoursInRange,
  resolveTimezone,
  timezoneIsCached,
  toLocalNaive,
  type ResolvedLocation,
} from "./location.js";
import {
  ARCHIVE_LAG_DAYS,
  fetchHourly,
  type HourlyObservation,
} from "./providers/openmeteo.js";

/**
 * Read-through hourly precipitation, mirroring lib/daily.ts.
 *
 * Storage is UTC; the response carries both the UTC instant and the naive
 * site-local timestamp, because rainhedge's feature pipeline joins POS receipts
 * against local wall-clock hours.
 */

export interface HourlyRecord {
  timestamp_local: string;
  timestamp_utc: string;
  precip_inches: number;
}

async function loadCoverage(
  key: string,
  start: string,
  end: string,
): Promise<{ observation_date: string; settled: boolean }[]> {
  const sql = db();
  return (await sql.query(
    `SELECT observation_date::text AS observation_date, settled
       FROM hourly_coverage
      WHERE location_key = $1 AND observation_date BETWEEN $2 AND $3`,
    [key, start, end],
  )) as { observation_date: string; settled: boolean }[];
}

async function loadObservations(
  key: string,
  start: string,
  end: string,
): Promise<{ observed_at_utc: string; precip_inches: number }[]> {
  const sql = db();
  // The end date is inclusive of its whole local day, so fetch a day past it in
  // UTC and let the caller trim — a site west of Greenwich sees its local
  // midnight after the UTC day has already rolled over.
  return (await sql.query(
    `SELECT to_char(observed_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed_at_utc,
            precip_inches::float8 AS precip_inches
       FROM hourly_precip
      WHERE location_key = $1
        AND observed_at_utc >= ($2::date - INTERVAL '1 day')
        AND observed_at_utc <  ($3::date + INTERVAL '2 days')
      ORDER BY observed_at_utc`,
    [key, start, end],
  )) as { observed_at_utc: string; precip_inches: number }[];
}

async function persist(
  key: string,
  observations: HourlyObservation[],
  fetchedDays: string[],
  cutoff: string,
): Promise<void> {
  const sql = db();

  if (observations.length > 0) {
    await sql.query(
      `INSERT INTO hourly_precip (location_key, observed_at_utc, precip_inches, source, settled)
       SELECT $1, t, p, 'open-meteo', (t AT TIME ZONE 'UTC')::date <= $4::date
         FROM UNNEST($2::timestamptz[], $3::numeric[]) AS u(t, p)
       ON CONFLICT (location_key, observed_at_utc, source) DO UPDATE
         SET precip_inches = EXCLUDED.precip_inches,
             settled       = EXCLUDED.settled,
             fetched_at    = now()`,
      [
        key,
        observations.map((o) => o.observed_at_utc),
        observations.map((o) => o.precip_inches),
        cutoff,
      ],
    );
  }

  if (fetchedDays.length === 0) return;

  const daysWithData = new Set(
    observations.map((o) => o.observed_at_utc.slice(0, 10)),
  );
  await sql.query(
    `INSERT INTO hourly_coverage (location_key, observation_date, source, has_data, settled)
     SELECT $1, d, 'open-meteo', h, d <= $4::date
       FROM UNNEST($2::date[], $3::boolean[]) AS t(d, h)
     ON CONFLICT (location_key, observation_date) DO UPDATE
       SET has_data   = EXCLUDED.has_data,
           settled    = EXCLUDED.settled,
           fetched_at = now()`,
    [key, fetchedDays, fetchedDays.map((day) => daysWithData.has(day)), cutoff],
  );
}

export interface HourlyResult {
  records: HourlyRecord[];
  coverage: { expected_hours: number; present_hours: number; pct: number };
  meta: { source: string; cache: "hit" | "partial" | "miss"; upstream_calls: number };
  timezone: string;
  fully_settled: boolean;
  archive_max_end_date: string;
}

export async function getHourly(
  location: ResolvedLocation,
  start: string,
  end: string,
  client: string,
): Promise<HourlyResult> {
  const cutoff = settledCutoff(ARCHIVE_LAG_DAYS);
  const range = eachDay(start, end);

  // Resolved here rather than at the route so its cost lands in upstream_calls:
  // the first request for a new location pays one call to learn the zone.
  const before = await timezoneIsCached(location.key);
  const timezone = await resolveTimezone(location, client);
  let upstreamCalls = before ? 0 : 1;

  // Open-Meteo is queried in GMT but the caller asked for local days, so the
  // local range spills past the UTC range by the site's offset. Pad a day each
  // side — no zone is more than 14 hours from UTC — and trim on the way out.
  const fetchStart = addDays(start, -1);
  const fetchEnd = addDays(end, 1);
  const fetchRange = eachDay(fetchStart, fetchEnd);

  const coverage = await loadCoverage(location.key, fetchStart, fetchEnd);
  const settledDays = new Set(
    coverage.filter((row) => row.settled).map((row) => row.observation_date),
  );
  const gaps = fetchRange.filter((day) => !settledDays.has(day));
  // Cache status describes the range the caller asked about, not the padding.
  const requestedGaps = range.filter((day) => !settledDays.has(day));

  for (const window of contiguousRanges(gaps)) {
    const observations = await fetchHourly(
      location.lat,
      location.lon,
      window.start,
      window.end,
      client,
    );
    upstreamCalls += 1;
    await persist(location.key, observations, eachDay(window.start, window.end), cutoff);
  }

  const stored = await loadObservations(location.key, start, end);

  // Trim to the requested range in *local* time — that is the range the caller
  // asked for, and it is not the same set of instants as the UTC range.
  const records: HourlyRecord[] = [];
  for (const row of stored) {
    const local = toLocalNaive(row.observed_at_utc, timezone);
    const localDate = local.slice(0, 10);
    if (localDate < start || localDate > end) continue;
    records.push({
      timestamp_local: local,
      timestamp_utc: row.observed_at_utc,
      precip_inches: row.precip_inches,
    });
  }
  records.sort((a, b) => a.timestamp_utc.localeCompare(b.timestamp_utc));

  // Not range.length * 24 — the DST days have 23 and 25 hours respectively.
  const expectedHours = localHoursInRange(start, end, timezone);
  return {
    records,
    coverage: {
      expected_hours: expectedHours,
      present_hours: records.length,
      pct: expectedHours === 0 ? 0 : Number((records.length / expectedHours).toFixed(4)),
    },
    meta: {
      source: "open-meteo",
      // "hit" must mean the response cost nothing upstream. Basing it on the
      // requested range alone would report a hit while the padding days were
      // still being fetched.
      cache:
        upstreamCalls === 0
          ? "hit"
          : requestedGaps.length === range.length
            ? "miss"
            : "partial",
      upstream_calls: upstreamCalls,
    },
    timezone,
    fully_settled: end <= cutoff,
    archive_max_end_date: cutoff,
  };
}
