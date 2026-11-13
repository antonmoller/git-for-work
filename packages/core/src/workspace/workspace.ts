export * as Workspace from "./workspace.ts"

import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Actor } from "@work/schema/actor"
import type { Claim } from "@work/schema/claim"
import type { Entry } from "@work/schema/entry"
import { Errors } from "@work/schema/errors"
import type { Key } from "@work/schema/key"
import type { Session } from "@work/schema/session"
import type { Task } from "@work/schema/task"
import type { Write } from "@work/schema/write"
import { ContentFields } from "../content/fields.ts"
import { ContentHash } from "../content/hash.ts"
import { Database } from "../database/database.ts"
import * as t from "../database/workspace.sql.ts"
import { KeyOverlap } from "../key/overlap.ts"

/** A claim is freed when its session has been quiet this long. */
export const CLAIM_TTL = 15 * 60_000
/** Drained entries stay in the hot tail this long before they are trimmed. */
export const HOT_RETENTION = 7 * 24 * 60 * 60_000

/** Who is calling, as the Worker established it, and from which session and trajectory. */
export interface Caller {
  readonly actor: Actor.Info
  readonly session: string | null
  /** The member of the session acting, as an address (`anna/claude`). */
  readonly member: string | null
  readonly trajectory: string | null
  readonly intent: string | null
  readonly now: number
}

type Row = typeof t.entry.$inferSelect
type ClaimRow = typeof t.claim.$inferSelect

const toEntry = (r: Row): Entry.Info => ({
  seq: r.seq,
  at: r.at,
  kind: r.kind as Entry.Kind,
  actor: r.actor as Actor.Info,
  member: r.member,
  session: r.session as Entry.Info["session"],
  trajectory: r.trajectory as Entry.Info["trajectory"],
  keys: r.keys as Key.Value[],
  title: r.title,
  version: r.version,
  base: r.base,
  content: r.content,
  fields: r.fields as string[],
  revertOf: r.revertOf,
  text: r.text,
  to: r.to,
  ref: r.ref,
  task: r.task,
  prev: r.prev,
  hash: r.hash,
})

const toClaim = (r: ClaimRow): Claim.Info => ({
  key: r.key as Key.Value,
  title: r.title,
  session: r.session as Claim.Info["session"],
  trajectory: r.trajectory as Claim.Info["trajectory"],
  intent: r.intent,
  holder: r.holder as Actor.Info,
  member: r.member,
  since: r.since,
  lastActive: r.lastActive,
})

const toTask = (r: typeof t.task.$inferSelect): Task.Info => ({
  id: r.id,
  title: r.title,
  status: r.status as Task.Info["status"],
  createdBy: r.createdBy as Actor.Info,
  createdAt: r.createdAt,
  from: r.from as Task.Info["from"],
  to: r.to,
  taker: r.taker as Actor.Info | null,
  takenAt: r.takenAt,
  doneAt: r.doneAt,
})

type Draft = Partial<Omit<Entry.Info, "seq" | "at" | "actor" | "prev" | "hash" | "kind">> & {
  readonly kind: Entry.Kind
}

/** Appends one entry to the chain. Must run inside the caller's transaction. */
const append = (caller: Caller, draft: Draft) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const last = yield* db.select({ seq: t.entry.seq, hash: t.entry.hash }).from(t.entry).orderBy(desc(t.entry.seq)).limit(1)
    const drained = yield* db.select().from(t.drain).where(eq(t.drain.id, 1))
    const head = last[0] ?? (drained[0] ? { seq: drained[0].seq, hash: drained[0].hash } : { seq: 0, hash: ContentHash.GENESIS })
    const body = {
      seq: head.seq + 1,
      at: caller.now,
      kind: draft.kind,
      actor: caller.actor,
      member: draft.member ?? caller.member,
      session: (draft.session ?? caller.session) as Entry.Info["session"],
      trajectory: (draft.trajectory ?? caller.trajectory) as Entry.Info["trajectory"],
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
      prev: head.hash,
    }
    const entry: Entry.Info = { ...body, hash: ContentHash.chain(body) }
    yield* db.insert(t.entry).values({ ...entry, drained: 0 })
    return entry
  })

const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.transaction(() => effect)
  })

const allClaims = Effect.gen(function* () {
  const database = yield* Database.Service
  return (yield* database.db.select().from(t.claim)).map(toClaim)
})

/** Claims held by other sessions that clash with any of `keys`. The all-or-none law rests on this. */
export const conflicts = (claims: ReadonlyArray<Claim.Info>, keys: ReadonlyArray<string>, session: string | null) =>
  claims.filter((c) => c.session !== session && keys.some((k) => KeyOverlap.overlaps(c.key, k)))

const ensureUrl = (key: string, title: string | null) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(t.url)
      .values({ key, title })
      .onConflictDoUpdate({ target: t.url.key, set: { title: sql`coalesce(${title}, ${t.url.title})` } })
  })

const insertClaims = (caller: Pick<Caller, "actor" | "session" | "member" | "trajectory" | "intent" | "now">, keys: ReadonlyArray<{ key: string; title: string | null }>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    for (const k of keys) {
      yield* ensureUrl(k.key, k.title)
      yield* database.db
        .insert(t.claim)
        .values({
          key: k.key,
          title: k.title,
          session: caller.session ?? "",
          trajectory: caller.trajectory,
          intent: caller.intent,
          holder: caller.actor,
          member: caller.member ?? "",
          since: caller.now,
          lastActive: caller.now,
        })
        .onConflictDoUpdate({ target: t.claim.key, set: { lastActive: caller.now, member: caller.member ?? "" } })
    }
  })

/**
 * Claims every key or none. Keys another session holds, or that sit above or below one it holds, are conflicts.
 * With `wait`, the caller queues and is granted the keys the moment they are all free, until the deadline.
 * Claims belong to the session, so every member of a joined session shares them.
 */
export const claim = (caller: Caller, keys: ReadonlyArray<{ key: string; title: string | null }>, wait = 0) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      if (keys.length === 0) return yield* new Errors.Invalid({ message: "Name at least one URL to claim" })
      const held = conflicts(yield* allClaims, keys.map((k) => k.key), caller.session)
      // Earlier waiters from other sessions go first, so a busy URL is handed over in order.
      const queued = (yield* database.db.select().from(t.waiter).where(eq(t.waiter.status, "waiting"))).filter(
        (w) => w.session !== caller.session && (w.keys as string[]).some((wk) => keys.some((k) => KeyOverlap.overlaps(wk, k.key))),
      )
      if (held.length === 0 && queued.length === 0) {
        yield* insertClaims(caller, keys)
        const entry = yield* append(caller, { kind: "claim", keys: keys.map((k) => k.key as Key.Value), title: keys[0].title })
        return { _tag: "Claimed", keys: keys.map((k) => k.key as Key.Value), seq: entry.seq } satisfies Claim.Result
      }
      if (wait <= 0) return { _tag: "Held", conflicts: held } satisfies Claim.Result
      const deadline = caller.now + wait
      const inserted = yield* database.db
        .insert(t.waiter)
        .values({
          keys: keys.map((k) => k.key),
          titles: keys.map((k) => k.title),
          session: caller.session ?? "",
          trajectory: caller.trajectory,
          intent: caller.intent,
          actor: caller.actor,
          member: caller.member ?? "",
          since: caller.now,
          deadline,
          status: "waiting",
        })
        .returning({ id: t.waiter.id })
      return { _tag: "Waiting", waiter: inserted[0].id, conflicts: held, deadline } satisfies Claim.Result
    }),
  )

/** Hands keys to waiters, oldest first, whose keys are now all free. Runs inside a transaction. */
const grant = (now: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const waiting = yield* database.db.select().from(t.waiter).where(eq(t.waiter.status, "waiting")).orderBy(asc(t.waiter.id))
    const granted: Array<{ waiter: number; session: string; seq: number }> = []
    for (const w of waiting) {
      const keys = w.keys as string[]
      if (conflicts(yield* allClaims, keys, w.session).length > 0) continue
      const titles = w.titles as Array<string | null>
      const holder = { actor: w.actor as Actor.Info, session: w.session, member: w.member, trajectory: w.trajectory, intent: w.intent, now }
      yield* insertClaims(holder, keys.map((key, i) => ({ key, title: titles[i] ?? null })))
      const entry = yield* append(holder, { kind: "claim", keys: keys as Key.Value[], title: titles[0] ?? null, text: "after waiting" })
      yield* database.db.update(t.waiter).set({ status: "granted", seq: entry.seq }).where(eq(t.waiter.id, w.id))
      granted.push({ waiter: w.id, session: w.session, seq: entry.seq })
    }
    return granted
  })

/** Releases the session's claims on `keys`, or all of them. The next waiters get them. */
export const release = (caller: Caller, keys?: ReadonlyArray<string>) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const mine = (yield* allClaims).filter((c) => c.session === caller.session && (!keys || keys.length === 0 || keys.some((k) => KeyOverlap.covers(k, c.key))))
      if (mine.length === 0) return { released: [] as string[], granted: [] as Array<{ waiter: number; session: string; seq: number }>, entry: null }
      yield* database.db.delete(t.claim).where(inArray(t.claim.key, mine.map((c) => c.key)))
      const entry = yield* append(caller, { kind: "release", keys: mine.map((c) => c.key) })
      const granted = yield* grant(caller.now)
      return { released: mine.map((c) => c.key as string), granted, entry }
    }),
  )

/** Abandons a waiter, for example when the CLI gives up. */
export const cancelWait = (session: string, waiter: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.update(t.waiter).set({ status: "cancelled" }).where(and(eq(t.waiter.id, waiter), eq(t.waiter.session, session), eq(t.waiter.status, "waiting")))
  })

export const waiterStatus = (waiter: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.select().from(t.waiter).where(eq(t.waiter.id, waiter))
    if (!rows[0]) return yield* new Errors.NotFound({ what: "waiter", id: String(waiter) })
    return { status: rows[0].status as "waiting" | "granted" | "expired" | "cancelled", seq: rows[0].seq, deadline: rows[0].deadline }
  })

/** Keeps a session's claims alive. */
export const touch = (session: string, now: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.update(t.claim).set({ lastActive: now }).where(eq(t.claim.session, session))
  })

/**
 * Frees claims whose session went quiet and ends waits past their deadline, then grants. Returns when to run next.
 */
export const expire = (now: number, system: Actor.Info) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const stale = (yield* database.db.select().from(t.claim).where(lt(t.claim.lastActive, now - CLAIM_TTL))).map(toClaim)
      for (const c of stale) {
        yield* database.db.delete(t.claim).where(eq(t.claim.key, c.key))
        yield* append(
          { actor: c.holder, session: c.session, member: c.member, trajectory: c.trajectory, intent: c.intent, now },
          { kind: "expire", keys: [c.key], text: `quiet since ${new Date(c.lastActive).toISOString()}` },
        )
      }
      yield* database.db.update(t.waiter).set({ status: "expired" }).where(and(eq(t.waiter.status, "waiting"), lte(t.waiter.deadline, now)))
      const granted = yield* grant(now)
      const claims = yield* database.db.select({ lastActive: t.claim.lastActive }).from(t.claim)
      const waits = yield* database.db.select({ deadline: t.waiter.deadline }).from(t.waiter).where(eq(t.waiter.status, "waiting"))
      const next = Math.min(...claims.map((c) => c.lastActive + CLAIM_TTL), ...waits.map((w) => w.deadline), Infinity)
      void system
      return { expired: stale.map((c) => c.key as string), granted, next: Number.isFinite(next) ? next : null }
    }),
  )

export interface WriteInput {
  readonly key: string
  readonly title: string | null
  /** The version the agent read before writing; null for a URL that has none yet. */
  readonly base: number | null
  /** The SHA-256 of the content, already stored by hash. */
  readonly content: string
  /** The content's fields (ContentFields.parse). */
  readonly fields: Record<string, string>
  readonly why: string | null
  readonly revertOf: number | null
  readonly reads: ReadonlyArray<string>
}

/**
 * Writes a new version. Refused if another session holds the URL or one above or below it, or if the URL moved
 * past `base`. Otherwise, in one transaction: append the entry, set the next version, renew the writer's claim.
 */
export const write = (caller: Caller, input: WriteInput) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const held = conflicts(yield* allClaims, [input.key], caller.session)
      if (held.length > 0) return yield* new Errors.KeyHeld({ key: input.key, conflicts: held })
      const current = (yield* db.select().from(t.url).where(eq(t.url.key, input.key)))[0]
      const currentVersion = current?.version ?? null
      if (currentVersion !== input.base) {
        if (currentVersion === null)
          return yield* new Errors.Invalid({ message: `${input.key} has no versions yet; write it without a base` })
        return yield* new Errors.StaleBase({
          key: input.key,
          base: input.base,
          current: currentVersion,
          at: current!.writtenAt ?? 0,
          by: current!.writtenBy as Actor.Info,
        })
      }
      const before = Object.fromEntries(
        (yield* db.select().from(t.field).where(eq(t.field.key, input.key))).filter((f) => f.value !== null).map((f) => [f.field, f.value as string]),
      )
      const changed = ContentFields.changed(before, input.fields)
      const version = (currentVersion ?? 0) + 1
      const entry = yield* append(caller, {
        kind: "write",
        keys: [input.key as Key.Value],
        title: input.title ?? current?.title ?? null,
        version,
        base: input.base,
        content: input.content,
        fields: changed,
        revertOf: input.revertOf,
        text: input.why,
      })
      yield* db.insert(t.version).values({
        key: input.key,
        version,
        seq: entry.seq,
        at: caller.now,
        actor: caller.actor,
        session: caller.session,
        trajectory: caller.trajectory,
        intent: caller.intent,
        why: input.why,
        base: input.base,
        content: input.content,
        changed,
        before: Object.fromEntries(changed.map((f) => [f, before[f] ?? null])),
        after: Object.fromEntries(changed.map((f) => [f, input.fields[f] ?? null])),
        revertOf: input.revertOf,
        reads: input.reads,
      })
      for (const f of changed)
        yield* db
          .insert(t.field)
          .values({ key: input.key, field: f, value: input.fields[f] ?? null, version })
          .onConflictDoUpdate({ target: [t.field.key, t.field.field], set: { value: input.fields[f] ?? null, version } })
      yield* db
        .insert(t.url)
        .values({ key: input.key, title: input.title, version, content: input.content, writtenAt: caller.now, writtenBy: caller.actor, seq: entry.seq })
        .onConflictDoUpdate({
          target: t.url.key,
          set: { title: sql`coalesce(${input.title}, ${t.url.title})`, version, content: input.content, writtenAt: caller.now, writtenBy: caller.actor, seq: entry.seq },
        })
      yield* db.update(t.claim).set({ lastActive: caller.now }).where(eq(t.claim.session, caller.session ?? ""))
      return { entry, version, changed }
    }),
  )

const versionRow = (r: typeof t.version.$inferSelect): Write.Version_ => ({
  key: r.key as Key.Value,
  version: r.version,
  seq: r.seq,
  at: r.at,
  actor: r.actor as Actor.Info,
  session: r.session as Write.Version_["session"],
  trajectory: r.trajectory as Write.Version_["trajectory"],
  intent: r.intent,
  why: r.why,
  base: r.base,
  content: r.content,
  changed: r.changed as string[],
  before: r.before as Record<string, string | null>,
  after: r.after as Record<string, string | null>,
  revertOf: r.revertOf,
  reads: r.reads as string[],
})

/** The first write after `version` that changed any of `fields`, if any. The revert law rests on this. */
export const laterOverlap = <V extends Pick<Write.Version_, "version" | "changed">>(versions: ReadonlyArray<V>, version: number, fields: ReadonlyArray<string>) =>
  [...versions].sort((a, b) => a.version - b.version).find((v) => v.version > version && v.changed.some((f) => fields.includes(f)))

/**
 * Prepares a revert: checks that no later write changed the same fields, claims the URL for the caller, and returns
 * the values to put back. The agent applies them in the app and logs `work put --revert`.
 */
export const revert = (caller: Caller, key: string, version: number, only?: ReadonlyArray<string>) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const versions = (yield* db.select().from(t.version).where(eq(t.version.key, key))).map(versionRow)
      const target = versions.find((v) => v.version === version)
      if (!target) return yield* new Errors.NotFound({ what: "version", id: `${key}@v${version}` })
      const fields = only && only.length > 0 ? target.changed.filter((f) => only.includes(f)) : target.changed
      const later = laterOverlap(versions, version, fields)
      if (later)
        return yield* new Errors.RevertConflict({
          key,
          version,
          later: later.version,
          fields: later.changed.filter((f) => fields.includes(f)),
          at: later.at,
          by: later.actor,
        })
      const held = conflicts(yield* allClaims, [key], caller.session)
      if (held.length > 0) return yield* new Errors.KeyHeld({ key, conflicts: held })
      const current = (yield* db.select().from(t.url).where(eq(t.url.key, key)))[0]
      yield* insertClaims(caller, [{ key, title: current?.title ?? null }])
      yield* append(caller, { kind: "revert.start", keys: [key as Key.Value], version: current?.version ?? version, revertOf: version, fields })
      const previous = versions.find((v) => v.version === version - 1)
      return {
        key: key as Key.Value,
        revertOf: version,
        current: current?.version ?? version,
        fields,
        values: Object.fromEntries(fields.map((f) => [f, target.before[f] ?? null])),
        baseContent: previous?.content ?? null,
      } satisfies Write.RevertPlan
    }),
  )

/** A person asks one of their agents to revert a write. It lands in that agent's (or the person's) inbox. */
export const requestRevert = (caller: Caller, key: string, version: number, to: string) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const exists = yield* database.db.select({ v: t.version.version }).from(t.version).where(and(eq(t.version.key, key), eq(t.version.version, version)))
      if (!exists[0]) return yield* new Errors.NotFound({ what: "version", id: `${key}@v${version}` })
      return yield* append(caller, { kind: "revert.request", keys: [key as Key.Value], version, revertOf: version, to })
    }),
  )

export const comment = (caller: Caller, input: { key: string | null; ref: number | null; text: string; version: number | null }) =>
  transaction(append(caller, { kind: "comment", keys: input.key ? [input.key as Key.Value] : [], ref: input.ref, text: input.text, version: input.version }))

/** `to` is an address (`karl/claude`), a person handle, or a key (whoever holds it). */
export const message = (caller: Caller, kind: "ask" | "tell", input: { to: string; text: string; ref: number | null; key: string | null }) =>
  transaction(append(caller, { kind, to: input.to, text: input.text, ref: input.ref, keys: input.key ? [input.key as Key.Value] : [] }))

export const addTask = (caller: Caller, title: string, to: string | null = null) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const row = yield* database.db
        .insert(t.task)
        .values({ title, status: "open", createdBy: caller.actor, createdAt: caller.now, from: caller.trajectory, to })
        .returning()
      const entry = yield* append(caller, { kind: to ? "handoff" : "task.add", task: row[0].id, text: title, to })
      return { task: toTask(row[0]), entry }
    }),
  )

const findTask = (idOrTitle: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = /^\d+$/.test(idOrTitle)
      ? yield* database.db.select().from(t.task).where(eq(t.task.id, Number(idOrTitle)))
      : yield* database.db.select().from(t.task).where(and(eq(t.task.title, idOrTitle), inArray(t.task.status, ["open", "taken"]))).orderBy(desc(t.task.id))
    if (!rows[0]) return yield* new Errors.NotFound({ what: "task", id: idOrTitle })
    return rows[0]
  })

/** One taker at a time. Taking your own task again is a no-op. */
export const takeTask = (caller: Caller, idOrTitle: string) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const row = yield* findTask(idOrTitle)
      const taker = row.taker as Actor.Info | null
      if (row.status === "done" || (row.status === "taken" && taker && (taker.person !== caller.actor.person || taker.agent !== caller.actor.agent)))
        return yield* new Errors.TaskTaken({ task: toTask(row) })
      const updated = yield* database.db.update(t.task).set({ status: "taken", taker: caller.actor, takenAt: caller.now }).where(eq(t.task.id, row.id)).returning()
      const entry = yield* append(caller, { kind: "task.take", task: row.id, text: row.title })
      return { task: toTask(updated[0]), entry }
    }),
  )

export const doneTask = (caller: Caller, idOrTitle: string) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const row = yield* findTask(idOrTitle)
      const updated = yield* database.db
        .update(t.task)
        .set({ status: "done", doneAt: caller.now, taker: row.taker ?? caller.actor, takenAt: row.takenAt ?? caller.now })
        .where(eq(t.task.id, row.id))
        .returning()
      const entry = yield* append(caller, { kind: "task.done", task: row.id, text: row.title })
      return { task: toTask(updated[0]), entry }
    }),
  )

export const tasks = (status?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = status ? yield* database.db.select().from(t.task).where(inArray(t.task.status, [...status])) : yield* database.db.select().from(t.task)
    return rows.map(toTask)
  })

export interface TrajectoryInput {
  readonly id: string
  readonly intent: string
  readonly forHandle: string
  readonly forName: string
}

export const startTrajectory = (caller: Caller, input: TrajectoryInput) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.insert(t.trajectory).values({
        id: input.id,
        session: caller.session ?? "",
        intent: input.intent,
        owner: caller.actor,
        forHandle: input.forHandle,
        forName: input.forName,
        status: "running",
        startedAt: caller.now,
        steps: 1,
        tools: 0,
        writes: 0,
      })
      return yield* append({ ...caller, trajectory: input.id, intent: input.intent }, { kind: "trajectory.start", text: input.intent, to: input.forHandle })
    }),
  )

/** Ends a trajectory and releases its session's claims. */
export const endTrajectory = (caller: Caller, id: string, status: "done" | "failed", why: string | null) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.update(t.trajectory).set({ status, endedAt: caller.now }).where(eq(t.trajectory.id, id))
    const released = yield* release(caller)
    const entry = yield* transaction(append({ ...caller, trajectory: id }, { kind: "trajectory.end", text: why, fields: [status] }))
    return { entry, released }
  })

/** Counts steps for Today's lanes. The session object reports them in batches. */
export const countSteps = (trajectory: string, steps: number, tools: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .update(t.trajectory)
      .set({ steps: sql`${t.trajectory.steps} + ${steps}`, tools: sql`${t.trajectory.tools} + ${tools}` })
      .where(eq(t.trajectory.id, trajectory))
  })

export const setPresence = (session: string, owner: Actor.Info, members: ReadonlyArray<Session.Member>, now: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(t.presence)
      .values({ session, owner, members, lastActive: now })
      .onConflictDoUpdate({ target: t.presence.session, set: { members, lastActive: now } })
  })

/** Who holds a URL (or one above or below it), who waits, and its current version. */
export const who = (key: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const current = (yield* database.db.select().from(t.url).where(eq(t.url.key, key)))[0]
    const holders = (yield* allClaims).filter((c) => KeyOverlap.overlaps(c.key, key))
    const waiters = (yield* database.db.select().from(t.waiter).where(eq(t.waiter.status, "waiting")))
      .filter((w) => (w.keys as string[]).some((k) => KeyOverlap.overlaps(k, key)))
      .map((w) => ({ id: w.id, keys: w.keys as Key.Value[], session: w.session as Claim.Waiter["session"], actor: w.actor as Actor.Info, since: w.since, deadline: w.deadline }))
    return {
      key: key as Key.Value,
      title: current?.title ?? null,
      version: current?.version ?? null,
      writtenAt: current?.writtenAt ?? null,
      writtenBy: (current?.writtenBy as Actor.Info | null) ?? null,
      holders,
      waiters,
    } satisfies Claim.Who
  })

export interface LogFilter {
  readonly key?: string
  /** Only entries after this version of `key`. */
  readonly sinceVersion?: number
  readonly sinceSeq?: number
  readonly beforeSeq?: number
  readonly by?: string
  readonly session?: string
  readonly trajectory?: string
  readonly limit?: number
}

/** The log, newest first, from the hot tail. Older history comes from the long-term log (docs/log.md). */
export const log = (filter: LogFilter = {}) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const conds = [
      filter.sinceSeq !== undefined ? gt(t.entry.seq, filter.sinceSeq) : undefined,
      filter.beforeSeq !== undefined ? lt(t.entry.seq, filter.beforeSeq) : undefined,
      filter.session ? eq(t.entry.session, filter.session) : undefined,
      filter.trajectory ? eq(t.entry.trajectory, filter.trajectory) : undefined,
    ].filter((c) => c !== undefined)
    const rows = yield* database.db.select().from(t.entry).where(conds.length ? and(...conds) : undefined).orderBy(desc(t.entry.seq))
    const entries = rows
      .map(toEntry)
      .filter((e) => !filter.key || e.keys.some((k) => KeyOverlap.covers(filter.key!, k)) || e.to === filter.key)
      .filter((e) => !filter.sinceVersion || (e.version ?? 0) > filter.sinceVersion)
      .filter((e) => !filter.by || `${e.actor.handle}${e.actor.agent ? `/${e.actor.agent}` : ""}` === filter.by || e.member === filter.by)
    return entries.slice(0, filter.limit ?? 200)
  })

export const entry = (seq: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.select().from(t.entry).where(eq(t.entry.seq, seq))
    if (!rows[0]) return yield* new Errors.NotFound({ what: "entry", id: String(seq) })
    return toEntry(rows[0])
  })

/** Every version of a URL, newest first, with its blame and comments. */
export const history = (key: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const versions = (yield* database.db.select().from(t.version).where(eq(t.version.key, key)).orderBy(desc(t.version.version))).map(versionRow)
    const fields = yield* database.db.select().from(t.field).where(eq(t.field.key, key))
    const blame = fields.map((f) => {
      const v = versions.find((x) => x.version === f.version)!
      return { field: f.field, version: f.version, at: v.at, actor: v.actor, trajectory: v.trajectory, value: f.value } satisfies Write.BlameLine
    })
    const comments = (yield* log({ key })).filter((e) => e.kind === "comment" || e.kind === "revert.request")
    const current = yield* who(key)
    return { who: current, versions, blame, comments }
  })

export const version = (key: string, v: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.select().from(t.version).where(and(eq(t.version.key, key), eq(t.version.version, v)))
    if (!rows[0]) return yield* new Errors.NotFound({ what: "version", id: `${key}@v${v}` })
    return versionRow(rows[0])
  })

/** Whether an entry is for this session: its agent, its person, or a URL it holds or wrote. Its own entries are not. */
export const isFor = (e: Entry.Info, me: { session: string; address: string; handle: string; keys: ReadonlyArray<string> }) => {
  if (e.session === me.session) return false
  const toMe = e.to !== null && (e.to === me.address || e.to === me.handle || e.to === me.session || me.keys.some((k) => KeyOverlap.overlaps(k, e.to!)))
  if (e.kind === "ask" || e.kind === "tell" || e.kind === "handoff" || e.kind === "revert.request") return toMe
  if (e.kind === "comment") return e.keys.some((k) => me.keys.some((m) => KeyOverlap.overlaps(m, k)))
  return false
}

/** Comments, questions, hand-offs and revert requests for this session since its cursor. */
export const inbox = (me: { session: string; address: string; handle: string }, advance: boolean) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const cursor = (yield* db.select().from(t.cursor).where(eq(t.cursor.session, me.session)))[0]?.seq ?? 0
    const held = (yield* allClaims).filter((c) => c.session === me.session).map((c) => c.key)
    const written = (yield* db.select({ key: t.version.key }).from(t.version).where(eq(t.version.session, me.session))).map((r) => r.key)
    const keys = [...new Set([...held, ...written])]
    const rows = (yield* db.select().from(t.entry).where(gt(t.entry.seq, cursor)).orderBy(asc(t.entry.seq))).map(toEntry)
    const items = rows.filter((e) => isFor(e, { ...me, keys }))
    const head = rows.at(-1)?.seq ?? cursor
    if (advance && head > cursor)
      yield* db.insert(t.cursor).values({ session: me.session, seq: head }).onConflictDoUpdate({ target: t.cursor.session, set: { seq: head } })
    return { items, cursor: head }
  })

/** Everything the Today screen needs, from the hot state. */
export const today = (since: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const trajectories = (yield* db.select().from(t.trajectory)).filter((r) => r.status === "running" || (r.endedAt ?? r.startedAt) >= since)
    const presence = yield* db.select().from(t.presence)
    const entries = (yield* db.select().from(t.entry).where(gt(t.entry.at, since)).orderBy(desc(t.entry.seq))).map(toEntry)
    return {
      trajectories: trajectories.map((r) => ({
        id: r.id,
        session: r.session,
        intent: r.intent,
        forHandle: r.forHandle,
        forName: r.forName,
        owner: r.owner as Actor.Info,
        status: r.status as Session.Trajectory["status"],
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        steps: r.steps,
        tools: r.tools,
        writes: entries.filter((e) => e.trajectory === r.id && e.kind === "write").length,
      })),
      presence: presence.map((p) => ({ session: p.session, owner: p.owner as Actor.Info, members: p.members as Session.Member[], lastActive: p.lastActive })),
      claims: yield* allClaims,
      tasks: yield* tasks(),
      entries,
    }
  })

/** Entries committed but not yet in the long-term log, oldest first. */
export const pending = (limit = 500) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return (yield* database.db.select().from(t.entry).where(eq(t.entry.drained, 0)).orderBy(asc(t.entry.seq)).limit(limit)).map(toEntry)
  })

/** Marks entries up to `seq` durable in the long-term log. Re-marking is harmless. */
export const drained = (seq: number, hash: string, now: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.update(t.entry).set({ drained: 1 }).where(lte(t.entry.seq, seq))
    yield* database.db
      .insert(t.drain)
      .values({ id: 1, seq, hash, inFlight: 0, updatedAt: now })
      .onConflictDoUpdate({ target: t.drain.id, set: { seq, hash, inFlight: 0, updatedAt: now } })
  })

/** Drops drained entries older than the hot window, always keeping the newest entry for the chain's head. */
export const trim = (now: number, retention = HOT_RETENTION) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const head = (yield* database.db.select({ seq: t.entry.seq }).from(t.entry).orderBy(desc(t.entry.seq)).limit(1))[0]?.seq ?? 0
    yield* database.db.delete(t.entry).where(and(eq(t.entry.drained, 1), lt(t.entry.at, now - retention), lt(t.entry.seq, head)))
  })
