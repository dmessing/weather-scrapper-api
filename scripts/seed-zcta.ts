/**
 * Seeds zcta_centroid from the Census 2020 ZCTA gazetteer (~33.8k rows).
 *
 * Run with `npm run seed:zcta`. Idempotent — re-running upserts.
 *
 * The gazetteer is distributed as a zip, so this shells out to `unzip` after
 * downloading. If the download is blocked in your environment, fetch the file
 * manually and drop the extracted .txt at data/2020_Gaz_zcta_national.txt:
 *
 *   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip
 *
 * Note: the national ZCTA file carries no state column, so zcta_centroid.state
 * is left NULL. Nothing in the service reads it today; it exists for reporting.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { db } from "../lib/db.js";

const run = promisify(execFile);

const VINTAGE = "2020";
const GAZETTEER_URL = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${VINTAGE}_Gazetteer/${VINTAGE}_Gaz_zcta_national.zip`;
const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const TXT_PATH = `${DATA_DIR}${VINTAGE}_Gaz_zcta_national.txt`;
const ZIP_PATH = `${DATA_DIR}${VINTAGE}_Gaz_zcta_national.zip`;

const BATCH_SIZE = 1_000;

interface Centroid {
  zip: string;
  lat: number;
  lon: number;
}

async function ensureGazetteer(): Promise<string> {
  try {
    return await readFile(TXT_PATH, "utf8");
  } catch {
    // Not cached yet — fall through and download.
  }

  console.log(`Downloading ${GAZETTEER_URL}`);
  await mkdir(DATA_DIR, { recursive: true });

  const response = await fetch(GAZETTEER_URL);
  if (!response.ok) {
    throw new Error(
      `Gazetteer download failed: ${response.status} ${response.statusText}. ` +
        `Download it manually and extract to ${TXT_PATH}.`,
    );
  }
  await writeFile(ZIP_PATH, Buffer.from(await response.arrayBuffer()));
  await run("unzip", ["-o", ZIP_PATH, "-d", DATA_DIR]);

  return readFile(TXT_PATH, "utf8");
}

/** The gazetteer is tab-separated with padded headers, hence the trimming. */
export function parseGazetteer(source: string): Centroid[] {
  const lines = source.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines.shift();
  if (!header) throw new Error("Gazetteer file is empty.");

  const columns = header.split("\t").map((name) => name.trim().toUpperCase());
  const zipIndex = columns.indexOf("GEOID");
  const latIndex = columns.indexOf("INTPTLAT");
  const lonIndex = columns.indexOf("INTPTLONG");

  if (zipIndex < 0 || latIndex < 0 || lonIndex < 0) {
    throw new Error(`Unexpected gazetteer columns: ${columns.join(", ")}`);
  }

  const centroids: Centroid[] = [];
  for (const line of lines) {
    const fields = line.split("\t");
    const zip = fields[zipIndex]?.trim();
    const lat = Number(fields[latIndex]?.trim());
    const lon = Number(fields[lonIndex]?.trim());

    if (!zip || !/^\d{5}$/.test(zip)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    centroids.push({ zip, lat, lon });
  }
  return centroids;
}

async function main(): Promise<void> {
  const centroids = parseGazetteer(await ensureGazetteer());
  console.log(`Parsed ${centroids.length} ZCTA centroids (vintage ${VINTAGE}).`);

  const sql = db();
  for (let offset = 0; offset < centroids.length; offset += BATCH_SIZE) {
    const batch = centroids.slice(offset, offset + BATCH_SIZE);
    await sql.query(
      `INSERT INTO zcta_centroid (zip, lat, lon)
       SELECT * FROM UNNEST($1::char(5)[], $2::numeric[], $3::numeric[])
       ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon`,
      [batch.map((c) => c.zip), batch.map((c) => c.lat), batch.map((c) => c.lon)],
    );
    console.log(`  upserted ${Math.min(offset + BATCH_SIZE, centroids.length)}/${centroids.length}`);
  }

  console.log("Seed complete.");
}

// Only run when invoked directly, so parseGazetteer can be unit-tested.
const entrypoint = process.argv[1] ? await realpath(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
