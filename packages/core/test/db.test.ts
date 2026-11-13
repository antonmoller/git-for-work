import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database.ts"
import { sqliteLayer } from "../src/database/sqlite.bun.ts"
import { claim } from "../src/database/workspace.sql.ts"

describe("database", () => {
  test("migrates and round-trips JSON columns", async () => {
    const program = Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.insert(claim).values({
        key: "erp.holm.se/x",
        session: "s1",
        holder: { a: 1 },
        member: "karl/codex",
        since: 1,
        lastActive: 1,
      })
      return yield* database.db.select().from(claim).where(eq(claim.key, "erp.holm.se/x"))
    })
    const rows = await Effect.runPromise(
      program.pipe(Effect.provide(Database.layer("workspace").pipe(Layer.provide(sqliteLayer({ filename: ":memory:" }))))),
    )
    expect(rows[0].holder).toEqual({ a: 1 })
  })
})
