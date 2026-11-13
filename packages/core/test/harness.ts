import { Effect, Layer } from "effect"
import type { Actor } from "@work/schema/actor"
import { Database } from "../src/database/database.ts"
import { sqliteLayer } from "../src/database/sqlite.bun.ts"
import type { Workspace } from "../src/workspace/workspace.ts"

/** Runs an effect against a fresh in-memory workspace database. */
export const runWorkspace = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layer("workspace").pipe(Layer.provide(sqliteLayer({ filename: ":memory:" }))))))

export const person = (handle: string, agent: string | null = null): Actor.Info => ({
  person: `user_${handle}` as Actor.Info["person"],
  handle,
  name: handle.charAt(0).toUpperCase() + handle.slice(1),
  agent,
})

let clock = 1_700_000_000_000
export const caller = (handle: string, agent: string, session: string, now = (clock += 1000)): Workspace.Caller => ({
  actor: person(handle, agent),
  session,
  member: `${handle}/${agent}`,
  trajectory: null,
  intent: null,
  now,
})
