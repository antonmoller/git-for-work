export * as Database from "./database.ts"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql"
import { EffectDrizzleSqlite } from "./drizzle/index.ts"
import { migrations } from "./migrations.gen.ts"

export type Kind = keyof typeof migrations

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
export type Db = Effect.Success<typeof makeDb>

export class Service extends Context.Service<Service, { readonly db: Db; readonly kind: Kind }>()(
  "@work/core/Database",
) {}

/** Applies the object kind's migrations that have not run yet. Each object runs this when it starts. */
export const migrate = (db: Db, kind: Kind) =>
  Effect.gen(function* () {
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS _migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    const done = new Set((yield* db.all<{ id: string }>(sql`SELECT id FROM _migration`)).map((r) => r.id))
    for (const migration of migrations[kind].filter((m) => !done.has(m.id))) {
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          for (const statement of migration.statements) yield* tx.run(sql.raw(statement))
          yield* tx.run(sql`INSERT INTO _migration (id, applied_at) VALUES (${migration.id}, ${Date.now()})`)
        }),
      )
    }
  })

/** The database over an injected SqlClient: Bun's SQLite in tests, Durable Object SQLite in the Worker. */
export const layer = (kind: Kind): Layer.Layer<Service, never, SqlClient.SqlClient> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* migrate(db, kind)
      return { db, kind }
    }).pipe(Effect.orDie),
  )
