import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Two drivers, one schema. The cloud web deployment uses node-postgres against
// DATABASE_URL (default). The fully-local desktop app sets PATHFORGE_LOCAL_DB to
// a data directory (or ":memory:") and runs an embedded Postgres (PGlite)
// in-process — no server, no DATABASE_URL. All query code is driver-agnostic.
const localDbPath = process.env.PATHFORGE_LOCAL_DB?.trim();

let database: NodePgDatabase<typeof schema>;
let poolInstance: pg.Pool | undefined;
let localClient: PGlite | undefined;

if (localDbPath) {
  localClient = new PGlite(localDbPath === ":memory:" ? undefined : localDbPath);
  // The PGlite query API is compatible with the node-postgres Drizzle surface
  // used across the app; typed as the node-postgres database to keep callers
  // unchanged.
  database = drizzlePglite(localClient, { schema }) as unknown as NodePgDatabase<typeof schema>;
} else {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database? " +
        "(Or set PATHFORGE_LOCAL_DB to run the embedded local database.)",
    );
  }
  poolInstance = new Pool({ connectionString: process.env.DATABASE_URL });
  database = drizzleNodePg(poolInstance, { schema });
}

export const db = database;
export const pool = poolInstance;

export * from "./schema";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/** True when running against the embedded local database. */
export const isLocalDatabase = Boolean(localClient);

/**
 * Applies schema migrations to the embedded PGlite database. No-op for cloud
 * Postgres (provisioned via `drizzle-kit push`). The local desktop backend must
 * call this once at startup before serving requests.
 */
export async function initLocalDatabase(): Promise<void> {
  if (!localClient) return;
  await migratePglite(database as never, { migrationsFolder });
}
