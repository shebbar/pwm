import pg from "pg";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SAFE_DB_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export let pool: pg.Pool;

function parseDatabaseName(connectionString: string): string {
  const url = new URL(connectionString);
  const name = decodeURIComponent(url.pathname.replace(/^\//, "") || "");
  if (!name) {
    throw new Error("DATABASE_URL must include a database name (e.g. .../pwm)");
  }
  if (!SAFE_DB_NAME.test(name)) {
    throw new Error(`Invalid database name in DATABASE_URL: ${name}`);
  }
  return name;
}

function withMaintenanceDb(connectionString: string, adminDb: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${adminDb}`;
  return url.toString();
}

/** Connect to postgres/template1 and CREATE DATABASE if the target DB is missing. */
export async function ensureDatabaseExists(): Promise<void> {
  const connectionString = process.env.DATABASE_URL!;
  const dbName = parseDatabaseName(connectionString);

  const maintenanceDbs = ["postgres", "template1"];
  let lastError: unknown;

  for (const adminDb of maintenanceDbs) {
    const adminPool = new pg.Pool({
      connectionString: withMaintenanceDb(connectionString, adminDb),
    });
    try {
      const { rows } = await adminPool.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [dbName]
      );
      if (rows.length === 0) {
        await adminPool.query(`CREATE DATABASE ${dbName}`);
        console.log(`Created database "${dbName}".`);
      }
      return;
    } catch (err) {
      lastError = err;
    } finally {
      await adminPool.end();
    }
  }

  throw lastError;
}

const MIGRATION_FILES = [
  "001_init.sql",
  "002_lump_sum_outgoes.sql",
  "003_lump_sum_inflows.sql",
  "004_swp_plans.sql",
  "005_investment_buckets.sql",
  "006_bucket_name.sql",
  "007_agent_runs.sql",
  "008_bucket_asset_class.sql",
  "009_agent_config.sql",
  "010_llm_models.sql",
  "011_pending_actions.sql",
  "012_agent_runs_observability.sql",
  "013_agent_run_critiques.sql",
  "014_critic_llm_model.sql",
];

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(
        join(__dirname, "migrations", file),
        "utf8"
      );
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

export async function initDatabase(): Promise<void> {
  await ensureDatabaseExists();
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  await runMigrations();
}

/**
 * For callers that connect to the database but aren't the single source of
 * truth for its schema (mcp-server.ts) -- assumes the database already
 * exists and is already migrated, and does neither itself. The api service
 * (index.ts, via initDatabase above) owns schema evolution; the MCP server
 * is a gateway that enforces access scopes over that same data, not a
 * second place that decides to create a database or alter its shape.
 *
 * This also avoids a real bug: before this split, both services called
 * initDatabase() independently on every boot, and CREATE TABLE IF NOT
 * EXISTS is not fully race-safe under true concurrency -- two processes
 * starting at nearly the same moment could both pass the "doesn't exist
 * yet" check and collide on the same catalog index, crashing one of them.
 * With only one caller of runMigrations(), that race can't happen.
 */
export function connectDatabase(): void {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
}
