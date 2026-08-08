import { neon } from "@neondatabase/serverless";
import { requireDatabaseUrl } from "./env.js";

/**
 * Neon's HTTP driver, not a pooled TCP client: each query is a stateless
 * request, so concurrent function instances can't exhaust connections. The
 * tradeoff is no interactive transactions — fine here, since every write is an
 * idempotent upsert into a cache table.
 */

type Sql = ReturnType<typeof neon>;

let cached: Sql | undefined;

export function db(): Sql {
  cached ??= neon(requireDatabaseUrl());
  return cached;
}

/** Split a .sql file into individual statements. */
export function splitStatements(source: string): string[] {
  // Comments are stripped *before* splitting: prose is allowed to contain
  // semicolons, and splitting first would hand Postgres half a sentence.
  //
  // Naive in the ways our migrations never exercise — a `--` inside a string
  // literal would be mistaken for a comment, and dollar-quoted function bodies
  // would split at their internal semicolons. Both are absent from this schema;
  // revisit if a trigger or function ever lands here.
  const withoutComments = source
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
