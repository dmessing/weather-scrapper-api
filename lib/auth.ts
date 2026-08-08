import { timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

/**
 * Per-consumer bearer token auth.
 *
 * This authenticates *services*, not end users. Every caller must be a trusted
 * server — a token shipped to a browser is a public token, and a public token
 * on this service means a stranger can burn the shared NOAA daily quota.
 */

/** token -> client name */
function parseClientTokens(raw: string | undefined): Map<string, string> {
  const entries = (raw ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .flatMap((pair) => {
      // Split once: the name cannot contain ':' but a token theoretically could.
      const separator = pair.indexOf(":");
      if (separator <= 0) return [];
      const name = pair.slice(0, separator).trim();
      const token = pair.slice(separator + 1).trim();
      if (!name || !token) return [];
      return [[token, name] as const];
    });
  return new Map(entries);
}

const clients = parseClientTokens(env.CLIENT_TOKENS);

/** Constant-time compare that tolerates length mismatch (timingSafeEqual throws on it). */
function tokensMatch(presented: string, known: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(known, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Returns the calling client's name, or `null` if the token is absent or unknown.
 *
 * The linear scan is deliberate: a `Map.get(presented)` would be a hash lookup
 * keyed on a secret, which leaks timing. With a handful of consumers the scan
 * costs nothing.
 */
export function authenticate(
  request: Request,
  registry: Map<string, string> = clients,
): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1];
  if (!presented) return null;

  let found: string | null = null;
  for (const [token, name] of registry) {
    // No early break: keep the work constant across which client matched.
    if (tokensMatch(presented, token)) found = name;
  }
  return found;
}

/** Exposed for tests and for the health check's "is auth even configured" probe. */
export const configuredClients = (): string[] => [...clients.values()];

export const __test = { parseClientTokens };
