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
| Daily history, by ZIP | NOAA CDO v2 (GHCND), ACIS fallback | planned |
| Hourly history | Open-Meteo ERA5 archive | planned |
| Real-time / forecast | NWS `api.weather.gov` | planned |

**Design rationale and the full build plan: [ARCHITECTURE.md](./ARCHITECTURE.md).**
The original NOAA research spec this started from is [README.txt](./README.txt).

## Status

Step 1 of 6 (skeleton) is done and verified against live Neon:

- [x] TypeScript + Vercel functions, zod, vitest
- [x] Per-consumer bearer auth (`lib/auth.ts`)
- [x] Neon HTTP driver, migration runner, full schema applied
- [x] `zcta_centroid` seeded — 33,144 rows, Census 2020 vintage
- [x] `GET /api/v1/health`
- [ ] `GET /api/v1/precip/daily` — CDO + read-through cache
- [ ] `GET /api/v1/precip/hourly` — Open-Meteo
- [ ] `GET /api/v1/precip/forecast` — NWS; ACIS as CDO fallback
- [ ] Vendored TS + Python clients; rainhedge migration
- [ ] `GET /api/v1/usage` — quota telemetry

Steps through `daily` make the service useful to fog-light. rainhedge needs `hourly`.

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

## Known limitations

- **ZCTAs are not ZIPs.** The Census gazetteer covers ~33.1k ZCTAs; USPS issues ~41k ZIP
  codes. PO-box-only and single-org ZIPs (e.g. `00501`) have no ZCTA and therefore no
  centroid, so any ZIP→lat/lon path will miss them. CDO's `ZIP:#####` lookup may still
  work for those; the centroid fallback won't.
- `zcta_centroid.state` is NULL — the national gazetteer file carries no state column.
  Nothing reads it today.
- `splitStatements` in `lib/db.ts` is a pragmatic SQL splitter: it strips comments, but
  would mishandle a `--` inside a string literal or a dollar-quoted function body. Neither
  appears in this schema.
