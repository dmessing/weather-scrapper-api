import { z } from "zod";

/**
 * A typed, validated view of the environment.
 *
 * Everything is optional at parse time so that `npm test` and `tsc` run without
 * a populated `.env`. Values that a given code path actually needs are pulled
 * through `require*()` accessors, which fail loudly at the point of use — a
 * missing NOAA token should break the CDO provider, not the health check.
 *
 * Note the spelling of `NEON_POSTGRESS_CONN_STR`: it is preserved as-is to
 * match the deployed variable rather than corrected.
 */

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  NOAA_TOKEN: z.string().trim().min(1).optional(),
  NEON_POSTGRESS_CONN_STR: z.string().trim().min(1).optional(),
  CLIENT_TOKENS: z.string().trim().optional(),
  NWS_USER_AGENT: z.string().trim().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();

function require_(name: keyof Env, hint: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. ${hint}`);
  }
  return value;
}

export const requireNoaaToken = (): string =>
  require_("NOAA_TOKEN", "Request one at https://www.ncdc.noaa.gov/cdo-web/token");

export const requireDatabaseUrl = (): string =>
  require_("NEON_POSTGRESS_CONN_STR", "Copy the connection string from the Neon console.");

export const requireNwsUserAgent = (): string =>
  require_(
    "NWS_USER_AGENT",
    "api.weather.gov requires a contact address, e.g. '(noaa-precip, you@example.com)'.",
  );
