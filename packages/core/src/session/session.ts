export * as Session from "./session.ts"

import { and, asc, desc, eq, gt } from "drizzle-orm"
import { Context, Effect, Layer, Semaphore } from "effect"
import type { Actor } from "@work/schema/actor"
import { Entry } from "@work/schema/entry"
import { Errors } from "@work/schema/errors"
import { Database } from "../database/database.ts"
import * as t from "../database/session.sql.ts"

/**
 * The session object's side of the log. A session's events are committed here first, numbered by `aseq`, and flushed
 * to the workspace in order, where the same (session, aseq) is stored once. Coordinated actions (claim, release,
 * write, revert, take a task) flush first, are decided and appended by the workspace, and are then pulled back here,
 * so both logs hold the same events in the same order.
 */

/** How the session object reaches its workspace. A Durable Object stub in the Worker, a direct call in tests. */
export interface LinkShape {
  /** Stores the events; returns the workspace's latest aseq for this session. */
  readonly replay: (events: ReadonlyArray<Entry.Event>) => Effect.Effect<number, Errors.Gap | Errors.Invalid>
  /** This session's events in the workspace after `aseq`, in order. */
  readonly since: (aseq: number) => Effect.Effect<ReadonlyArray<Entry.Event>>
}

export class Link extends Context.Service<Link, LinkShape>()("@work/core/SessionLink") {}

/** Serializes everything that appends to this session's log, so aseq stays contiguous across awaits. */
export class Lock extends Context.Service<Lock, Semaphore.Semaphore>()("@work/core/SessionLock") {}

export const lockLayer = Layer.effect(Lock, Semaphore.make(1))

export interface Who {
  readonly session: string
  readonly actor: Actor.Info
  readonly member: string
  readonly now: number
}

type Draft = Partial<Omit<Entry.Event, "id" | "aggregate" | "aseq" | "at" | "actor" | "kind" | "session">> & {
  readonly kind: Entry.Kind
}

const eventId = (now: number) => `evt_${now.toString(36).padStart(9, "0")}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`

const meta = <A>(key: string, fallback: A) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const row = (yield* database.db.select().from(t.meta).where(eq(t.meta.key, key)))[0]
    return row ? (row.value as A) : fallback
  })

const setMeta = (key: string, value: unknown) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(t.meta).values({ key, value }).onConflictDoUpdate({ target: t.meta.key, set: { value } })
  })

const latest = Effect.gen(function* () {
  const database = yield* Database.Service
  return (yield* database.db.select({ aseq: t.event.aseq }).from(t.event).orderBy(desc(t.event.aseq)).limit(1))[0]?.aseq ?? 0
})

const insert = (event: Entry.Event) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(t.event).values({ aseq: event.aseq, id: event.id, at: event.at, kind: event.kind, trajectory: event.trajectory, member: event.member, body: event })
    return event
  })

/** The member's current trajectory, set by `start` and cleared by `end`. */
export const current = (member: string) => meta<string | null>(`current:${member}`, null)

export const flushed = meta<number>("flushed", 0)

/** Commits one of the session's own events here. It reaches the workspace on the next flush. */
export const record = (who: Who, draft: Draft) =>
  Effect.gen(function* () {
    const lock = yield* Lock
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const trajectory = draft.trajectory === undefined ? yield* current(who.member) : draft.trajectory
        return yield* insert({
          id: eventId(who.now),
          aggregate: who.session,
          aseq: (yield* latest) + 1,
          at: who.now,
          kind: draft.kind,
          actor: who.actor,
          member: draft.member ?? who.member,
          session: who.session as Entry.Event["session"],
          trajectory: trajectory as Entry.Event["trajectory"],
          keys: draft.keys ?? [],
          title: draft.title ?? null,
          version: draft.version ?? null,
          base: draft.base ?? null,
          content: draft.content ?? null,
          fields: draft.fields ?? [],
          revertOf: draft.revertOf ?? null,
          text: draft.text ?? null,
          to: draft.to ?? null,
          ref: draft.ref ?? null,
          task: draft.task ?? null,
          data: draft.data ?? null,
        })
      }),
    )
  })

/** Starts a trajectory for a member of the session. */
export const start = (who: Who, input: { id: string; intent: string; forHandle: string; forName: string }) =>
  Effect.gen(function* () {
    const event = yield* record(who, { kind: "trajectory.start", trajectory: input.id as Entry.Event["trajectory"], text: input.intent, data: { forHandle: input.forHandle, forName: input.forName } })
    yield* setMeta(`current:${who.member}`, input.id)
    return event
  })

/** Ends the member's current trajectory. Releasing its claims is a coordinated call the caller makes after. */
export const end = (who: Who, status: "done" | "failed", why: string | null) =>
  Effect.gen(function* () {
    const id = yield* current(who.member)
    if (!id) return yield* new Errors.Invalid({ message: "No trajectory is running; start one with `work start`" })
    const event = yield* record(who, { kind: "trajectory.end", trajectory: id as Entry.Event["trajectory"], title: status, text: why })
    yield* setMeta(`current:${who.member}`, null)
    return event
  })

const flushBatch = Effect.gen(function* () {
  const database = yield* Database.Service
  const link = yield* Link
  const from = yield* flushed
  const batch = (yield* database.db.select().from(t.event).where(gt(t.event.aseq, from)).orderBy(asc(t.event.aseq)).limit(200)).map((r) => r.body as Entry.Event)
  if (batch.length === 0) return from
  const head = yield* link.replay(batch).pipe(
    // The workspace is behind what we thought flushed (it lost nothing durable, but we may have crashed before
    // recording its answer): resend from where it is.
    Effect.catchTag("Gap", (gap) =>
      Effect.gen(function* () {
        const resend = (yield* database.db.select().from(t.event).where(and(gt(t.event.aseq, gap.expected - 1))).orderBy(asc(t.event.aseq)).limit(200)).map((r) => r.body as Entry.Event)
        return yield* link.replay(resend)
      }),
    ),
  )
  yield* setMeta("flushed", head)
  return head
})

const unlockedFlush = Effect.gen(function* () {
  const database = yield* Database.Service
  for (;;) {
    const head = yield* flushBatch
    const last = (yield* database.db.select({ aseq: t.event.aseq }).from(t.event).orderBy(desc(t.event.aseq)).limit(1))[0]?.aseq ?? 0
    if (head >= last) return head
  }
})

/** Sends unflushed events to the workspace, in order. Safe to retry: the workspace skips what it has. */
export const flush = Effect.gen(function* () {
  const lock = yield* Lock
  return yield* lock.withPermits(1)(unlockedFlush)
})

/** Events the workspace holds for this session that this object does not, such as a write it decided before a crash. */
const unlockedPull = Effect.gen(function* () {
  const link = yield* Link
  const have = yield* latest
  const missing = yield* link.since(have)
  for (const event of missing) yield* insert(event)
  if (missing.length > 0) yield* setMeta("flushed", missing.at(-1)!.aseq)
  return missing
})

/** On start: take back anything the workspace decided that this object never recorded. */
export const repair = Effect.gen(function* () {
  const lock = yield* Lock
  return yield* lock.withPermits(1)(unlockedPull)
})

/**
 * Runs a coordinated action: flush everything first, so the workspace sees this session's events in order, let the
 * workspace decide and append, then pull its events back here. A refusal is recorded as the session's own event.
 */
export const coordinate = <A, E, R>(who: Who, kind: Entry.Kind, keys: ReadonlyArray<string>, action: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lock = yield* Lock
    const result = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* unlockedFlush
        const exit = yield* Effect.result(action)
        yield* unlockedPull
        return exit
      }),
    )
    if (result._tag === "Success") return result.success
    const error = result.failure as { _tag?: string }
    yield* record(who, { kind: "refused", keys: keys as Entry.Event["keys"], title: kind, text: error._tag ?? "refused", data: error })
    return yield* Effect.fail(result.failure)
  })

/** The session's own log, oldest first, from `after`. */
export const events = (after = 0, trajectory?: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db
      .select()
      .from(t.event)
      .where(trajectory ? and(gt(t.event.aseq, after), eq(t.event.trajectory, trajectory)) : gt(t.event.aseq, after))
      .orderBy(asc(t.event.aseq))
    return rows.map((r) => r.body as Entry.Event)
  })

/** The trajectories this session has run, newest first, from its own log. */
export const trajectories = Effect.gen(function* () {
  const all = yield* events()
  return all
    .filter((e) => e.kind === "trajectory.start")
    .map((s) => {
      const steps = all.filter((e) => e.trajectory === s.trajectory)
      const ended = steps.find((e) => e.kind === "trajectory.end")
      const data = (s.data ?? {}) as { forHandle?: string; forName?: string }
      return {
        id: s.trajectory!,
        session: s.session!,
        intent: s.text ?? "",
        forHandle: data.forHandle ?? s.actor.handle,
        forName: data.forName ?? s.actor.name,
        owner: s.actor,
        status: (ended ? (ended.title === "failed" ? "failed" : "done") : "running") as "running" | "done" | "failed",
        startedAt: s.at,
        endedAt: ended?.at ?? null,
        steps: steps.filter((e) => e.kind !== "tool").length,
        tools: steps.filter((e) => e.kind === "tool").length,
        writes: steps.filter((e) => e.kind === "write").length,
      }
    })
    .reverse()
})

/** The owner is set once, by the first call that names this session. */
export const owner = meta<Actor.Info | null>("owner", null)

export const claimOwner = (actor: Actor.Info) =>
  Effect.gen(function* () {
    const existing = yield* owner
    if (existing) return existing
    yield* setMeta("owner", actor)
    return actor
  })
