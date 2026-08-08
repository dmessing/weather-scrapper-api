import { db } from "./db.js";
import { LIMITS } from "./upstream.js";

/**
 * Quota telemetry.
 *
 * The point of a shared service is that one place knows what the shared budget
 * has been spent on. This reports that: how much of NOAA's daily ceiling is
 * gone, which consumer spent it, and whether the read-through cache is actually
 * keeping the number down.
 *
 * The quota day is UTC (see migration 004), matching NOAA's reset.
 */

const WARN_FRACTION = 0.85;

export interface QuotaSummary {
  provider: string;
  used: number;
  /** Provider-side failures: 5xx and 429. These are worth alerting on. */
  errors: number;
  /** Input-driven refusals: other 4xx, e.g. a point outside NWS coverage. */
  rejected: number;
  quota: number | null;
  remaining: number | null;
  pct_used: number | null;
  warn: boolean;
  exhausted: boolean;
}

/** Pure so the thresholds are testable without a database. */
export function summarizeQuota(
  provider: string,
  used: number,
  errors: number,
  rejected: number,
  quota: number | undefined,
): QuotaSummary {
  if (quota === undefined) {
    // Providers that publish no ceiling still get usage reported, just no
    // percentage — a made-up denominator would be worse than none.
    return {
      provider,
      used,
      errors,
      rejected,
      quota: null,
      remaining: null,
      pct_used: null,
      warn: false,
      exhausted: false,
    };
  }

  return {
    provider,
    used,
    errors,
    rejected,
    quota,
    remaining: Math.max(0, quota - used),
    pct_used: Number((used / quota).toFixed(4)),
    warn: used >= quota * WARN_FRACTION,
    exhausted: used >= quota,
  };
}

export interface UsageReport {
  quota_day_utc: string;
  providers: QuotaSummary[];
  by_client: { client: string; provider: string; calls: number }[];
  recent_days: { day: string; provider: string; calls: number }[];
  cache: {
    daily_observations: number;
    daily_days_covered: number;
    hourly_observations: number;
    hourly_days_covered: number;
    locations_known: number;
    zips_with_stations: number;
  };
  warnings: string[];
}

export async function buildUsageReport(): Promise<UsageReport> {
  const sql = db();

  const [today] = (await sql`SELECT (now() AT TIME ZONE 'UTC')::date::text AS day`) as {
    day: string;
  }[];
  const quotaDay = today?.day ?? "";

  const usage = (await sql`
    SELECT provider,
           count(*)::int AS used,
           -- 5xx and 429 are the provider failing us; other 4xx are requests we
           -- sent that could never have succeeded (a point outside coverage, a
           -- ZIP with no geography). Conflating them makes the warning noise.
           count(*) FILTER (WHERE status >= 500 OR status = 429)::int AS errors,
           count(*) FILTER (WHERE status >= 400 AND status < 500 AND status <> 429)::int AS rejected
      FROM upstream_call_log
     WHERE called_on = (now() AT TIME ZONE 'UTC')::date
     GROUP BY provider
  `) as { provider: string; used: number; errors: number; rejected: number }[];

  const byClient = (await sql`
    SELECT client, provider, count(*)::int AS calls
      FROM upstream_call_log
     WHERE called_on = (now() AT TIME ZONE 'UTC')::date
     GROUP BY client, provider
     ORDER BY calls DESC
  `) as { client: string; provider: string; calls: number }[];

  const recentDays = (await sql`
    SELECT called_on::text AS day, provider, count(*)::int AS calls
      FROM upstream_call_log
     WHERE called_on >= (now() AT TIME ZONE 'UTC')::date - 6
     GROUP BY called_on, provider
     ORDER BY day DESC, provider
  `) as { day: string; provider: string; calls: number }[];

  const [cache] = (await sql`
    SELECT (SELECT count(*) FROM daily_precip)::int      AS daily_observations,
           (SELECT count(*) FROM daily_coverage)::int    AS daily_days_covered,
           (SELECT count(*) FROM hourly_precip)::int     AS hourly_observations,
           (SELECT count(*) FROM hourly_coverage)::int   AS hourly_days_covered,
           (SELECT count(*) FROM location_timezone)::int AS locations_known,
           (SELECT count(DISTINCT zip) FROM zip_station)::int AS zips_with_stations
  `) as UsageReport["cache"][];

  // Report every provider we know about, not only those called today, so a
  // provider sitting at zero is visibly at zero rather than absent.
  const usageByProvider = new Map(usage.map((row) => [row.provider, row]));
  const providers = Object.keys(LIMITS)
    .map((provider) => {
      const row = usageByProvider.get(provider);
      return summarizeQuota(
        provider,
        row?.used ?? 0,
        row?.errors ?? 0,
        row?.rejected ?? 0,
        LIMITS[provider]?.dailyQuota,
      );
    })
    .sort((a, b) => b.used - a.used);

  const warnings: string[] = [];
  for (const provider of providers) {
    if (provider.exhausted) {
      warnings.push(
        `${provider.provider} daily quota exhausted (${provider.used}/${provider.quota}); requests are falling back or failing`,
      );
    } else if (provider.warn) {
      warnings.push(
        `${provider.provider} at ${provider.used}/${provider.quota} of today's quota (>=85%)`,
      );
    }
    if (provider.errors > 0) {
      warnings.push(
        `${provider.provider} returned ${provider.errors} failure response(s) today (5xx/429)`,
      );
    }
  }

  return {
    quota_day_utc: quotaDay,
    providers,
    by_client: byClient,
    recent_days: recentDays,
    cache: cache ?? {
      daily_observations: 0,
      daily_days_covered: 0,
      hourly_observations: 0,
      hourly_days_covered: 0,
      locations_known: 0,
      zips_with_stations: 0,
    },
    warnings,
  };
}
