import { db } from "./db.js";
import { ApiError } from "./http.js";

/**
 * Everything that guards an outbound provider call: the shared token bucket,
 * the daily quota ceiling, retry/backoff, and per-consumer attribution.
 *
 * The bucket lives in Postgres rather than in module scope because Vercel runs
 * many concurrent function instances — a per-instance limiter would let N
 * instances each believe they were within a 4 req/sec budget.
 */

export interface ProviderLimits {
  /** Sustained requests per second. */
  ratePerSecond: number;
  /** Burst capacity. */
  capacity: number;
  /** Hard daily ceiling, or undefined when the provider publishes none. */
  dailyQuota?: number;
}

export const LIMITS: Record<string, ProviderLimits> = {
  // NOAA publishes 5/sec and 10,000/day; we sit deliberately under both.
  cdo: { ratePerSecond: 4, capacity: 4, dailyQuota: 10_000 },
  acis: { ratePerSecond: 2, capacity: 4 },
  "open-meteo": { ratePerSecond: 5, capacity: 10 },
  nws: { ratePerSecond: 5, capacity: 10 },
};

const QUOTA_WARN_FRACTION = 0.85;
const MAX_RETRIES = 3;
const MAX_BUCKET_WAIT_MS = 5_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Atomically refill-and-take one token. Returns false when the bucket is dry,
 * leaving the caller to wait and retry. The refill is computed inside the
 * UPDATE so that concurrent instances serialise on the row lock.
 */
async function tryTake(provider: string, limits: ProviderLimits): Promise<boolean> {
  const sql = db();
  const rows = await sql.query(
    `UPDATE rate_limit_bucket
        SET tokens = LEAST($2::numeric,
                           tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * $3::numeric) - 1,
            updated_at = now()
      WHERE provider = $1
        AND LEAST($2::numeric,
                  tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * $3::numeric) >= 1
      RETURNING tokens`,
    [provider, limits.capacity, limits.ratePerSecond],
  );
  return (rows as unknown[]).length > 0;
}

async function acquire(provider: string, limits: ProviderLimits): Promise<void> {
  const sql = db();
  // Seed the row on first use. ON CONFLICT DO NOTHING keeps this race-free.
  await sql.query(
    `INSERT INTO rate_limit_bucket (provider, tokens)
     VALUES ($1, $2) ON CONFLICT (provider) DO NOTHING`,
    [provider, limits.capacity],
  );

  const deadline = Date.now() + MAX_BUCKET_WAIT_MS;
  for (;;) {
    if (await tryTake(provider, limits)) return;
    if (Date.now() >= deadline) {
      throw new ApiError(429, "rate_limited", `${provider} token bucket exhausted`);
    }
    await sleep(1000 / limits.ratePerSecond);
  }
}

export interface QuotaStatus {
  provider: string;
  used: number;
  quota?: number;
  warn: boolean;
}

export async function quotaStatus(provider: string): Promise<QuotaStatus> {
  const sql = db();
  const rows = (await sql.query(
    // Explicit UTC rather than CURRENT_DATE: the quota day must not depend on
    // the session's TimeZone setting. See migration 004.
    `SELECT count(*)::int AS used FROM upstream_call_log
      WHERE provider = $1 AND called_on = (now() AT TIME ZONE 'UTC')::date`,
    [provider],
  )) as { used: number }[];

  const used = rows[0]?.used ?? 0;
  const quota = LIMITS[provider]?.dailyQuota;
  return {
    provider,
    used,
    quota,
    warn: quota !== undefined && used >= quota * QUOTA_WARN_FRACTION,
  };
}

async function logCall(client: string, provider: string, status: number): Promise<void> {
  const sql = db();
  await sql.query(
    `INSERT INTO upstream_call_log (client, provider, status) VALUES ($1, $2, $3)`,
    [client, provider, status],
  );
}

/**
 * Runs a single upstream HTTP call under the bucket, the quota ceiling, and
 * exponential backoff on 429/503.
 */
export async function callUpstream(
  provider: string,
  client: string,
  request: () => Promise<Response>,
): Promise<Response> {
  const limits = LIMITS[provider];
  if (!limits) throw new Error(`Unknown provider ${provider}`);

  const status = await quotaStatus(provider);
  if (status.quota !== undefined && status.used >= status.quota) {
    throw new ApiError(429, "daily_quota_exhausted", {
      provider,
      used: status.used,
      quota: status.quota,
    });
  }
  if (status.warn) {
    console.warn(
      `[quota] ${provider} at ${status.used}/${status.quota} for today (>=85%)`,
    );
  }

  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await acquire(provider, limits);

    const response = await request();
    await logCall(client, provider, response.status);

    if (response.status !== 429 && response.status !== 503) return response;

    lastResponse = response;
    if (attempt < MAX_RETRIES) {
      // 0.5s, 1s, 2s — the spec's 2^n * 0.5.
      await sleep(2 ** attempt * 500);
    }
  }

  throw new ApiError(502, "upstream_unavailable", {
    provider,
    status: lastResponse?.status,
  });
}
