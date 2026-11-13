import { Effect, Layer, ManagedRuntime } from "effect"
import type { Actor } from "@work/schema/actor"
import { Database } from "../src/database/database.ts"
import { sqliteLayer } from "../src/database/sqlite.bun.ts"
import { Session } from "../src/session/session.ts"
import { Workspace } from "../src/workspace/workspace.ts"

const memory = (kind: Database.Kind) => Database.layer(kind).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))

/** Runs an effect against a fresh in-memory workspace database. */
export const runWorkspace = <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Effect.runPromise(effect.pipe(Effect.provide(memory("workspace"))))

export const person = (handle: string, agent: string | null = null): Actor.Info => ({
  person: `user_${handle}` as Actor.Info["person"],
  handle,
  name: handle.charAt(0).toUpperCase() + handle.slice(1),
  agent,
})

let clock = 1_700_000_000_000
export const tick = () => (clock += 1000)

export const caller = (handle: string, agent: string, session: string, now = tick()): Workspace.Caller => ({
  actor: person(handle, agent),
  session,
  member: `${handle}/${agent}`,
  trajectory: null,
  intent: null,
  now,
})

/**
 * A workspace object and any number of session objects, each with its own in-memory database, linked the way the
 * Worker links them. `faults` simulates a crash after the workspace committed but before the session heard back.
 */
export const world = () => {
  const ws = ManagedRuntime.make(memory("workspace"))
  const inWorkspace = <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Effect.flatten(Effect.promise(() => ws.runPromiseExit(effect)))
  const faults = { replayReplyLost: 0, pullLost: 0 }
  const sessions = new Map<string, ManagedRuntime.ManagedRuntime<Database.Service | Session.Link | Session.Lock, never>>()
  const session = (id: string) => {
    const existing = sessions.get(id)
    if (existing) return existing
    const link = Layer.succeed(
      Session.Link,
      Session.Link.of({
        replay: (events) =>
          inWorkspace(Workspace.replay(id, events, tick())).pipe(
            Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }),
            Effect.flatMap((head) => (faults.replayReplyLost > 0 ? (faults.replayReplyLost--, Effect.die(new Error("reply lost"))) : Effect.succeed(head))),
          ),
        since: (aseq) =>
          faults.pullLost > 0 ? (faults.pullLost--, Effect.die(new Error("pull lost"))) : Effect.orDie(inWorkspace(Workspace.sessionEvents(id, aseq))),
      }),
    )
    const runtime = ManagedRuntime.make(Layer.mergeAll(memory("session"), Session.lockLayer, link))
    sessions.set(id, runtime)
    return runtime
  }
  return {
    faults,
    workspace: <A, E>(effect: Effect.Effect<A, E, Database.Service>) => ws.runPromise(effect),
    inWorkspace,
    session: <A, E>(id: string, effect: Effect.Effect<A, E, Database.Service | Session.Link | Session.Lock>) => session(id).runPromise(effect),
    sessionExit: <A, E>(id: string, effect: Effect.Effect<A, E, Database.Service | Session.Link | Session.Lock>) => session(id).runPromiseExit(effect),
    who: (id: string, handle: string, agent: string): Session.Who => ({ session: id, actor: person(handle, agent), member: `${handle}/${agent}`, now: tick() }),
  }
}
