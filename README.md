# noaa-precip

A single precipitation API, deployed as Vercel functions, serving both
[`fog-light`](../fog-light) (Next.js/TS on Vercel) and
[`weather-backtest`](../weather-backtest) (`rainhedge`, Python/Streamlit on Render).

It exists because NOAA CDO's rate limits — 5 req/sec, 10,000 req/day — attach to the
*token*, not the caller. Two apps hitting NOAA independently can't coordinate that budget.
One service owns the token, the retry policy, the ZIP→station resolution, and the cache,
and can attribute every upstream call to a named consumer.

Despite the name, this is not a NOAA proxy. CDO's GHCND dataset is daily-only, so hourly
precipitation — which rainhedge's elasticity engine needs — comes from Open-Meteo instead.
Three providers sit behind one contract:

| Grain | Provider | Status |
| --- | --- | --- |
| Daily history, by ZIP | NOAA CDO v2 (GHCND) | **live** |
| Hourly history | Open-Meteo ERA5 archive | **live** |
| Daily fallback | ACIS | **live** |
| Real-time / forecast | NWS `api.weather.gov` | **live** |

**Design rationale and the full build plan: [ARCHITECTURE.md](./ARCHITECTURE.md).**
The original NOAA research spec this started from is [README.txt](./README.txt).

## Status

Steps 1–5 of 6 are done, each verified against the live upstream:

- [x] TypeScript + Vercel functions, zod, vitest
- [x] Per-consumer bearer auth (`lib/auth.ts`)
- [x] Neon HTTP driver, migration runner, full schema applied
- [x] `zcta_centroid` seeded — 33,144 rows, Census 2020 vintage
- [x] `GET /api/v1/health`
- [x] `GET /api/v1/precip/daily` — CDO, pagination, backoff, read-through cache
- [x] `GET /api/v1/precip/hourly` — Open-Meteo, UTC storage, DST-correct local rendering
- [x] `GET /api/v1/precip/forecast` — NWS gridpoint QPF + probability
- [x] ACIS fallback for daily, narrowed to the nearest stations
- [x] Vendored TS + Python clients; rainhedge migrated off its own Open-Meteo fetcher
- [ ] `GET /api/v1/usage` — quota telemetry

Both consumers can build against the API now.

## Daily precipitation

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/precip/daily?zip=06107&start=2026-07-01&end=2026-07-07"
```

Returns per-station `records`, a mean-across-stations `aggregate`, and a `coverage` block.
**Missing days are absent, never zero-filled** — a backtest has to be able to tell a hole
from a dry day. Observations that failed NOAA's own QC flag are dropped for the same
reason: a wrong number that looks real is worse than a gap.

`meta.cache` reports `miss` / `partial` / `hit`, and `meta.upstream_calls` how many NOAA
requests the response actually cost. A repeat of a settled range costs zero.

Constraints worth knowing:

- **366 days max per request** — CDO rejects longer spans. Page client-side.
- Days within 3 days of today are treated as unsettled and refetched on each request;
  older days are immutable and served from Neon forever.
- `cache-control` is a year for a fully-settled range, an hour otherwise.

## Hourly precipitation

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/precip/hourly?zip=06107&start=2026-07-05&end=2026-07-07"
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/precip/hourly?lat=41.7523&lon=-72.7581&start=2026-07-05&end=2026-07-07"
```

Accepts either a ZIP or explicit coordinates — rainhedge addresses sites by lat/lon, since
a car wash is at a point rather than in a tabulation area.

Each record carries **both** timestamps:

```json
{ "timestamp_local": "2026-07-05T01:00:00", "timestamp_utc": "2026-07-05T05:00:00Z",
  "precip_inches": 0.004 }
```

`timestamp_local` is naive site-local — what you join POS receipts against. `timestamp_utc`
is what makes the series unambiguous across a DST transition. Storage is UTC; local
rendering happens on the way out through the site's IANA zone, so spring-forward and
fall-back land correctly rather than being smeared by a single fixed offset.

Consequences worth knowing:

- **`expected_hours` is not `days × 24`.** The spring-forward day has 23 hours and the
  fall-back day has 25. A three-day range spanning the March transition reports 71.
- **Range grain is local days**, so the service fetches a padded UTC window and trims. That
  padding is cached like anything else, so it costs at most one extra call per boundary.
- `archive_max_end_date` is returned on every response. ERA5 lags real time by ~6 days;
  read this rather than hard-coding a lag constant. Days past it still return data (the
  archive backfills) but are marked unsettled and refetched.
- The first request for a new location costs one extra upstream call to learn its
  timezone, cached permanently thereafter. `meta.upstream_calls` includes it.

## Setup

Requires Node 22+.

```bash
npm install
cp .env.example .env     # then fill it in
npm run migrate          # apply migrations/*.sql
npm run seed:zcta        # ~33.8k ZIP centroids from the Census gazetteer
```

`.env` holds four values — see `.env.example`. Note `NEON_POSTGRESS_CONN_STR` is spelled
that way deliberately, matching the deployed variable rather than correcting it.

Mint a consumer token with `npm run mint-token`, then add it to `CLIENT_TOKENS` as a
comma-separated `name:token` pair:

```
CLIENT_TOKENS=fog-light:3f9a…,rainhedge:c710…
```

Adding a third consumer later is a config change, not a code change.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | `vercel dev` |
| `npm test` | vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | Apply unapplied `migrations/*.sql`; idempotent |
| `npm run seed:zcta` | Download + upsert ZCTA centroids; idempotent |
| `npm run mint-token` | Print a 32-byte hex token |

## Health

```bash
curl "$BASE/api/v1/health"                          # shallow, unauthenticated
curl -H "Authorization: Bearer $TOKEN" \
     "$BASE/api/v1/health?deep=1"                   # pings Postgres, reports migrations
```

Shallow is open so uptime checks can hit it freely. Deep costs a query and reveals
internals, so it needs a token.

## Auth

Every endpoint except shallow health requires `Authorization: Bearer <token>`.

This authenticates **services, not end users**. All calls must originate server-side —
Next.js route handlers or server components in fog-light, never the browser. A token
shipped to a browser is a public token, and a public token here means a stranger can
exhaust the shared NOAA quota. If fog-light ever needs precip data client-side, it proxies
through its own authenticated route.

Token comparison is `timingSafeEqual` behind a length guard rather than a map lookup,
since a hash lookup keyed on a secret leaks timing.

Rotation is additive: add the new token alongside the old, switch the consumer over, drop
the old one. No downtime.

## Layout

```
api/v1/         HTTP handlers (Vercel functions, web-standard Request/Response)
lib/            auth, env, db, http helpers — the shared guts
migrations/     numbered .sql, applied in filename order
scripts/        migrate + seed, run locally via tsx
data/           gitignored; the downloaded Census gazetteer lands here
```

## Forecast

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/precip/forecast?zip=06107&days=7"
```

Returns a `daily` rollup and the raw `intervals` series. Not persisted: a forecast is
mutable, and a stored one without its issue time is indistinguishable from a stale one.
Served live under a one-hour CDN TTL, with `issued_at` on every response.

- **Depth sums, probability maxes.** Two adjacent 40% windows are a 40% day, not 80%.
- NWS publishes QPF over multi-hour windows. Those intervals pass through unmodified
  rather than being spread evenly across their hours, which would invent detail the
  forecast doesn't contain. An interval straddling local midnight is attributed to the day
  it starts in.
- Days are counted from **today at the site**, not at the server. The NWS grid series opens
  before the current hour, so its first bucket is usually yesterday; those are dropped.
- US and territories only — anything else returns `422 outside_nws_coverage`.

## Daily fallback chain

`/precip/daily` tries three tiers before reporting a gap:

1. **CDO by ZIP** — `locationid=ZIP:#####`, the normal path.
2. **CDO by station** — centroid bounding-box search when the ZIP has no CDO coverage.
3. **ACIS by bounding box** — a different station network entirely.

A CDO outage or an exhausted daily quota falls through to ACIS rather than failing the
request. `meta.source` reports which provider actually answered (`cdo`, `acis`, or
`cdo+acis` when a multi-window request used both).

## Clients

Both clients live in `clients/` and are **vendored by copying** — no registry, no publish
step. `clients/` is the source of truth; if you edit a vendored copy, edit the original too.

| Client | Source | Vendored to |
| --- | --- | --- |
| TypeScript | `clients/ts/precip-client.ts` | `fog-light/src/lib/precip-client.ts` |
| Python | `clients/py/precip_client.py` | `weather-backtest/src/rainhedge/precip_client.py` |

Both read `PRECIP_API_URL` and `PRECIP_API_TOKEN` from the environment and raise a typed
error (`PrecipApiError`) carrying the service's `code`, so callers can tell
`no_centroid_for_zip` from an outage.

### rainhedge

`weather.py` now delegates to the service. Its public contract is unchanged —
`fetch_historical_precipitation(lat, lon, start, end)` still returns naive site-local
`timestamp` plus `precipitation` in inches — so `features.py`, `baseline.py` and
`elasticity.py` were not touched. The local `.cache/weather` disk cache and the direct
Open-Meteo call are gone.

Two deliberate deviations from the original plan:

- `use_cache` is kept as a no-op parameter rather than removed, so existing call sites keep
  working. Caching is server-side now.
- `archive_max_end_date()` stays a **local** pure function. app.py calls it during Streamlit
  layout, and making that a network round-trip would have put an HTTP call in the widget
  path. The service's authoritative value is on every hourly response, and
  `service_archive_max_end_date(lat, lon)` fetches it when the exact cutoff matters.

### fog-light

`src/lib/precip-forecast.ts` maps a service forecast into the `ForecastDay` shape
`dashboard-data.ts` already defines, so the card can switch over without markup changes. It
returns `null` when the service is unconfigured or unreachable — a precipitation outage
should degrade the forecast card, not the whole operator dashboard.

## Known limitations

- **ZCTAs are not ZIPs.** The Census gazetteer covers ~33.1k ZCTAs; USPS issues ~41k ZIP
  codes. PO-box-only and single-org ZIPs have no ZCTA and therefore no centroid, so the
  fallback path can't run for them. Confirmed live: `00501` returns `422 no_centroid_for_zip`
  rather than an empty result that would read as "no rain".
- **The bounding-box station fallback is written but not yet exercised in anger.** It only
  triggers for a ZIP that has a centroid *and* zero CDO station coverage; the ZIPs tested so
  far (`06107`, `99546`) both resolved directly through `locationid=ZIP:#####`.
- **Station aggregation is an unweighted mean, and this now demonstrably matters.**
  Measured live for West Hartford on 2026-07-05: CDO's single ZIP gauge read 0.41", while
  the mean of the five nearest ACIS stations read 0.81". The nearest ACIS station matched
  CDO exactly — the spread is real spatial variability in summer convective rain, not a
  bug. For a contract that settles on a measurement, "mean of nearby gauges" and "the
  gauge at the site" are different numbers, and the choice belongs to whoever writes the
  contract. ARCHITECTURE §3's weighting question is no longer theoretical.
- **fog-light's forecast card is laid out for 14 days; NWS publishes 7.** The card renders
  a `grid-cols-14` strip from mock data. Against live data it will fill half its width until
  that is reconciled — either narrow the card, or source days 8–14 from somewhere that
  actually forecasts that far out. The seam is built; the card is not switched over.
- **Switching tiers can shift the number.** A range answered partly by CDO and partly by
  ACIS mixes two station networks. `meta.source` and the per-row `station` field make this
  visible, but nothing currently prevents it.
- `zcta_centroid.state` is NULL — the national gazetteer file carries no state column.
  Nothing reads it today.
- `splitStatements` in `lib/db.ts` is a pragmatic SQL splitter: it strips comments, but
  would mishandle a `--` inside a string literal or a dollar-quoted function body. Neither
  appears in this schema.
