import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { households } from "@/db/schema";
import type { LedgrDb } from "@/db";
import { withReadOnlyHousehold } from "@/lib/household-context";
import { createTestDb } from "./setup";

describe("read-only household transaction", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => {
    await close();
  });

  it("sets transaction read-only mode and the household context", async () => {
    const state = await withReadOnlyHousehold(
      "household-machine",
      async (tx) => {
        const result = await tx.execute(sql`
          select
            current_setting('transaction_read_only') as read_only,
            current_setting('app.household_id') as household_id
        `);
        return result.rows[0] as {
          read_only: string;
          household_id: string;
        };
      },
      db,
    );

    expect(state).toEqual({
      read_only: "on",
      household_id: "household-machine",
    });
  });

  it("rejects attempted writes and leaves no persisted row", async () => {
    await expect(
      withReadOnlyHousehold(
        "household-machine",
        (tx) =>
          tx.insert(households).values({
            id: "must-not-persist",
            name: "Must Not Persist",
          }),
        db,
      ),
    ).rejects.toThrow();

    const rows = await db
      .select({ id: households.id })
      .from(households);
    expect(rows).not.toContainEqual({ id: "must-not-persist" });
  });
});
