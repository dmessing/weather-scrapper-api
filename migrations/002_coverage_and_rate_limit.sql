-- 002: what we've already asked for, and the shared token bucket.

-- A read-through cache needs to distinguish "NOAA has no observation for this
-- day" from "we never asked". Without that, every genuinely-empty day looks
-- like a cache miss forever and burns quota on each request.
--
-- One row per (zip, day) we have queried. `has_data` records the answer,
-- `settled` marks days past the provider's reporting lag, which are immutable
-- and never refetched.
CREATE TABLE IF NOT EXISTS daily_coverage (
    zip              CHAR(5) NOT NULL,
    observation_date DATE NOT NULL,
    source           VARCHAR(16) NOT NULL,
    has_data         BOOLEAN NOT NULL DEFAULT false,
    settled          BOOLEAN NOT NULL DEFAULT false,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zip, observation_date)
);

CREATE INDEX IF NOT EXISTS idx_coverage_zip_date
    ON daily_coverage (zip, observation_date);

-- Token bucket, in Postgres so the limit holds across concurrent function
-- instances rather than per-instance. One row per upstream provider.
CREATE TABLE IF NOT EXISTS rate_limit_bucket (
    provider   VARCHAR(16) PRIMARY KEY,
    tokens     NUMERIC(10, 4) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
