export * as Organization from "./organization.ts"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Key } from "@work/schema/key"
import { Errors } from "@work/schema/errors"
import { Database } from "../database/database.ts"
import * as t from "../database/organization.sql.ts"

export const workspaces = Effect.gen(function* () {
  const database = yield* Database.Service
  return (yield* database.db.select().from(t.workspace)).map((w) => ({ slug: w.slug, name: w.name, createdAt: w.createdAt, rules: w.rules as Key.Rule[] }))
})

export const createWorkspace = (slug: string, name: string, by: string, now: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return yield* new Errors.Invalid({ message: "A workspace slug is lowercase letters, digits and dashes" })
    const existing = (yield* database.db.select().from(t.workspace).where(eq(t.workspace.slug, slug)))[0]
    if (existing) return { slug: existing.slug, name: existing.name, createdAt: existing.createdAt }
    yield* database.db.insert(t.workspace).values({ slug, name, createdAt: now, createdBy: by, rules: [] })
    return { slug, name, createdAt: now }
  })

export interface Person {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly handle: string
}

export const person = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const row = (yield* database.db.select().from(t.person).where(eq(t.person.id, id)))[0]
    return row ? { row: { id: row.id, email: row.email, name: row.name, handle: row.handle } satisfies Person, updatedAt: row.updatedAt } : null
  })

/**
 * Stores a person's profile. Handles are unique in the organization: the email's local part, with a number added
 * when another person already has it.
 */
export const savePerson = (input: { id: string; email: string; name: string }, now: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const existing = (yield* db.select().from(t.person).where(eq(t.person.id, input.id)))[0]
    const base = input.email.split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "") || "person"
    const taken = new Set((yield* db.select({ handle: t.person.handle, id: t.person.id }).from(t.person)).filter((p) => p.id !== input.id).map((p) => p.handle))
    const handle = existing?.handle ?? [base, ...Array.from({ length: 50 }, (_, i) => `${base}${i + 2}`)].find((h) => !taken.has(h))!
    yield* db
      .insert(t.person)
      .values({ id: input.id, email: input.email, name: input.name, handle, updatedAt: now })
      .onConflictDoUpdate({ target: t.person.id, set: { email: input.email, name: input.name, updatedAt: now } })
    return { id: input.id, email: input.email, name: input.name, handle } satisfies Person
  })
