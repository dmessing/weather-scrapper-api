/**
 * Applies every unapplied file in migrations/ in filename order.
 *
 * Run with `npm run migrate`. Idempotent: applied filenames are recorded in
 * schema_migrations and skipped on subsequent runs.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db, splitStatements } from "../lib/db.js";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url).pathname;

async function main(): Promise<void> {
  const sql = db();

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (
      (await sql`SELECT filename FROM schema_migrations`) as { filename: string }[]
    ).map((row) => row.filename),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) {
      console.log(`  skip  ${filename}`);
      continue;
    }

    const source = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    const statements = splitStatements(source);

    // The HTTP driver has no interactive transactions, so a migration that
    // fails midway leaves earlier statements applied and is not recorded.
    // Every statement here is IF NOT EXISTS, so a re-run finishes the job.
    for (const statement of statements) {
      await sql.query(statement);
    }

    await sql`INSERT INTO schema_migrations (filename) VALUES (${filename})`;
    console.log(`  apply ${filename} (${statements.length} statements)`);
    count += 1;
  }

  console.log(count === 0 ? "Already up to date." : `Applied ${count} migration(s).`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
