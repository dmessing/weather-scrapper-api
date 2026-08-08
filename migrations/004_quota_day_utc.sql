-- 004: pin the quota day to UTC.
--
-- CURRENT_DATE resolves against the session's TimeZone setting. Neon currently
-- runs GMT so the value is right today, but a session that set TimeZone
-- differently would file calls under the wrong day and silently corrupt the
-- daily quota count. NOAA's ceiling resets on a UTC day, so say so explicitly
-- rather than depending on a server default.

ALTER TABLE upstream_call_log
    ALTER COLUMN called_on SET DEFAULT (now() AT TIME ZONE 'UTC')::date;
