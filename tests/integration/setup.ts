import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { randomUUID } from "crypto";
import * as schema from "../../src/db/schema";
import path from "node:path";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";

export async function createTestDb(options: { migrationThrough?: number } = {}) {
  const connectionString =
    process.env.DATABASE_URL || "postgresql://ledgr:ledgr@localhost:5432/ledgr_test";

  const dbName = `test_${randomUUID().replace(/-/g, "")}`;

  // Isolate each test file in its own *database* (not a schema). Migrations
  // reference tables as `"public"."<table>"`, which only resolves when the
  // objects live in the public schema — a per-schema/search_path approach breaks
  // on those qualified references. A throwaway database per file gives every test
  // its own public schema, keeps the concurrent suite isolated, and is robust to
  // future migrations regardless of how they qualify identifiers.
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;

  const pool = new Pool({ connectionString: url.toString() });
  const db = drizzle({ client: pool, schema });
  const migrationsFolder = path.join(process.cwd(), "src/db/migrations");
  let selectedFolder: string | null = null;
  if (options.migrationThrough !== undefined) {
    selectedFolder = await mkdtemp(path.join(os.tmpdir(), "ledgr-migrations-"));
    await mkdir(path.join(selectedFolder, "meta"));
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= options.migrationThrough!);
    await writeFile(path.join(selectedFolder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries as { tag: string }[]) {
      await cp(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(selectedFolder, `${entry.tag}.sql`));
    }
  }
  try {
    await migrate(db, { migrationsFolder: selectedFolder ?? migrationsFolder });
  } finally {
    if (selectedFolder) await rm(selectedFolder, { recursive: true, force: true });
  }

  return {
    db,
    async close() {
      await pool.end();
      // DROP DATABASE cannot run while connections are open; FORCE terminates any
      // stragglers (Postgres 13+).
      const admin2 = new Pool({ connectionString });
      await admin2.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin2.end();
    },
  };
}
