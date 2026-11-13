export * as Workspace from "./workspace.ts"

import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Actor } from "@work/schema/actor"
import type { Claim } from "@work/schema/claim"
import { Entry } from "@work/schema/entry"
import { Errors } from "@work/schema/errors"
import type { Key } from "@work/schema/key"
import type { Session } from "@work/schema/session"
import type { Task } from "@work/schema/task"
import type { Write } from "@work/schema/write"
import { ContentFields } from "../content/fields.ts"
import { Database } from "../database/database.ts"
import * as t from "../database/workspace.sql.ts"
import { KeyOverlap } from "../key/overlap.ts"

/** A claim is freed when its session has been quiet this long. */
export const CLAIM_TTL = 15 * 60_000

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

type ClaimRow = typeof t.claim.$inferSelect

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

/** A new event id, ascending by time. */
export const eventId = (now: number) => `evt_${now.toString(36).padStart(9, "0")}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`

type Draft = Partial<Omit<Entry.Event, "id" | "aggregate" | "aseq" | "at" | "actor" | "kind">> & { readonly kind: Entry.Kind }

const toInfo = (r: typeof t.entry.$inferSelect): Entry.Info => ({ ...(r.body as Entry.Event), seq: r.seq })

/** Stores one event and advances its aggregate's sequence. Must run inside the caller's transaction. */
const store = (event: Entry.Event) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const inserted = yield* db
      .insert(t.entry)
      .values({
        id: event.id,
        aggregate: event.aggregate,
        aseq: event.aseq,
        at: event.at,
        kind: event.kind,
        by: Actor.address(event.actor),
        member: event.member,
        session: event.session,
        trajectory: event.trajectory,
        keys: event.keys,
        to: event.to,
        version: event.version,
        body: event,
      })
      .returning({ seq: t.entry.seq })
    yield* db
      .insert(t.sequence)
      .values({ aggregate: event.aggregate, aseq: event.aseq })
      .onConflictDoUpdate({ target: t.sequence.aggregate, set: { aseq: event.aseq } })
    return { ...event, seq: inserted[0].seq } satisfies Entry.Info
  })

const latest = (aggregate: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return (yield* database.db.select().from(t.sequence).where(eq(t.sequence.aggregate, aggregate)))[0]?.aseq ?? 0
  })

/**
 * Appends the caller's event as the next of its aggregate: the caller's session, or the workspace for a person in
 * the browser. Must run inside the caller's transaction.
 */
const append = (caller: Caller, draft: Draft) =>
  Effect.gen(function* () {
    const aggregate = caller.session ?? Entry.WORKSPACE
    return yield* store({
      id: eventId(caller.now),
      aggregate,
      aseq: (yield* latest(aggregate)) + 1,
      at: caller.now,
      kind: draft.kind,
      actor: caller.actor,
      member: draft.member ?? caller.member,
      session: (draft.session ?? caller.session) as Entry.Event["session"],
      trajectory: (draft.trajectory ?? caller.trajectory) as Entry.Event["trajectory"],
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
  })

/** Appends an event the workspace makes on no session's behalf: expiries and grants. */
const appendForWorkspace = (caller: Caller, draft: Draft) => append({ ...caller, session: null }, { session: caller.session as Entry.Event["session"], ...draft })

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
      const entry = yield* appendForWorkspace(holder, { kind: "claim", keys: keys as Key.Value[], title: titles[0] ?? null, text: "after waiting" })
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

/**
 * Abandons a waiter, for example when the CLI gives up. Returns where it ended: a waiter granted just before the
 * cancel arrived stays granted, and the caller holds the keys until it releases them.
 */
export const cancelWait = (session: string, waiter: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.update(t.waiter).set({ status: "cancelled" }).where(and(eq(t.waiter.id, waiter), eq(t.waiter.session, session), eq(t.waiter.status, "waiting")))
    return yield* waiterStatus(waiter)
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
        yield* appendForWorkspace(
          { actor: c.holder, session: c.session, member: c.member, trajectory: c.trajectory, intent: c.intent, now },
          { kind: "expire", keys: [c.key], text: `quiet since ${new Date(c.lastActive).toISOString()}` },
        )
      }
      yield* database.db.update(t.waiter).set({ status: "expired" }).where(and(eq(t.waiter.status, "waiting"), lte(t.waiter.deadline, now)))
      const granted = yield* grant(now)
      void system
      return { expired: stale.map((c) => c.key as string), granted, next: yield* nextAlarm }
    }),
  )

/** When a claim next goes quiet or a wait ends, for the object's alarm. Null when nothing is pending. */
export const nextAlarm = Effect.gen(function* () {
  const database = yield* Database.Service
  const claims = yield* database.db.select({ lastActive: t.claim.lastActive }).from(t.claim)
  const waits = yield* database.db.select({ deadline: t.waiter.deadline }).from(t.waiter).where(eq(t.waiter.status, "waiting"))
  const next = Math.min(...claims.map((c) => c.lastActive + CLAIM_TTL), ...waits.map((w) => w.deadline), Infinity)
  return Number.isFinite(next) ? next : null
})

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
      return {
        key: key as Key.Value,
        revertOf: version,
        current: current?.version ?? version,
        fields,
        values: Object.fromEntries(fields.map((f) => [f, target.before[f] ?? null])),
        /** The hash of the current content; the caller restores the fields onto it. */
        content: current?.content ?? null,
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

/** A comment from a person in the browser. Agents comment through their session's log. */
export const comment = (caller: Caller, input: { key: string | null; ref: number | null; text: string; version: number | null }) =>
  transaction(append(caller, { kind: "comment", keys: input.key ? [input.key as Key.Value] : [], ref: input.ref, text: input.text, version: input.version }))

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

export const tasks = (status?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = status ? yield* database.db.select().from(t.task).where(inArray(t.task.status, [...status])) : yield* database.db.select().from(t.task)
    return rows.map(toTask)
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

/**
 * Takes a session's events, flushed in aseq order, with opencode's replay rules: an event at or below its
 * aggregate's latest aseq must be the one already stored (same id) and is skipped; otherwise it must be exactly the
 * next aseq. Each new event is projected and stored in one transaction. Returns the session's latest aseq.
 */
export const replay = (session: string, events: ReadonlyArray<Entry.Event>, now: number) =>
  transaction(
    Effect.gen(function* () {
      const database = yield* Database.Service
      for (const event of [...events].sort((a, b) => a.aseq - b.aseq)) {
        if (event.aggregate !== session || event.session !== session)
          return yield* new Errors.Invalid({ message: `Event ${event.id} is not from session ${session}` })
        const head = yield* latest(session)
        if (event.aseq <= head) {
          const stored = (yield* database.db.select({ id: t.entry.id }).from(t.entry).where(and(eq(t.entry.aggregate, session), eq(t.entry.aseq, event.aseq))))[0]
          if (stored?.id === event.id) continue
          return yield* Effect.die(new Error(`Replay diverged for ${session} at ${event.aseq}`))
        }
        if (event.aseq !== head + 1) return yield* new Errors.Gap({ aggregate: session, expected: head + 1, got: event.aseq })
        yield* project(event)
        yield* store(event)
      }
      yield* touch(session, now)
      return yield* latest(session)
    }),
  )

/** The read tables a session's own events update. Coordinated events update theirs where they are decided. */
const project = (e: Entry.Event) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    if (e.kind === "trajectory.start" && e.trajectory) {
      const data = (e.data ?? {}) as { forHandle?: string; forName?: string }
      yield* db
        .insert(t.trajectory)
        .values({
          id: e.trajectory,
          session: e.session ?? "",
          intent: e.text ?? "",
          owner: e.actor,
          forHandle: data.forHandle ?? e.actor.handle,
          forName: data.forName ?? e.actor.name,
          status: "running",
          startedAt: e.at,
          steps: 1,
          tools: 0,
          writes: 0,
        })
        .onConflictDoNothing()
    }
    if (e.kind === "trajectory.end" && e.trajectory)
      yield* db.update(t.trajectory).set({ status: e.title === "failed" ? "failed" : "done", endedAt: e.at }).where(eq(t.trajectory.id, e.trajectory))
    if (e.trajectory && (e.kind === "note" || e.kind === "read" || e.kind === "tool"))
      yield* db
        .update(t.trajectory)
        .set(e.kind === "tool" ? { tools: sql`${t.trajectory.tools} + 1` } : { steps: sql`${t.trajectory.steps} + 1` })
        .where(eq(t.trajectory.id, e.trajectory))
    if ((e.kind === "task.add" || e.kind === "handoff") && e.text)
      yield* db.insert(t.task).values({ title: e.text, status: "open", createdBy: e.actor, createdAt: e.at, from: e.trajectory, to: e.kind === "handoff" ? e.to : null })
    if (e.kind === "task.done" && e.text) {
      const row = (yield* db.select().from(t.task).where(and(eq(t.task.title, e.text), inArray(t.task.status, ["open", "taken"]))).orderBy(desc(t.task.id)))[0]
      if (row) yield* db.update(t.task).set({ status: "done", doneAt: e.at, taker: row.taker ?? e.actor, takenAt: row.takenAt ?? e.at }).where(eq(t.task.id, row.id))
    }
  })

/** A session's latest aseq here, so a restarted session object knows where its flush stands. */
export const sessionHead = (session: string) => latest(session)

export interface LogFilter {
  readonly key?: string
  /** Only entries after this version of `key`. */
  readonly sinceVersion?: number
  readonly sinceSeq?: number
  readonly beforeSeq?: number
  readonly by?: string
  readonly session?: string
  readonly trajectory?: string
  readonly kinds?: ReadonlyArray<string>
  readonly limit?: number
  readonly order?: "asc" | "desc"
}

/** The workspace log. Newest first unless `order: "asc"`. */
export const log = (filter: LogFilter = {}) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const conds = [
      filter.sinceSeq !== undefined ? gt(t.entry.seq, filter.sinceSeq) : undefined,
      filter.beforeSeq !== undefined ? lt(t.entry.seq, filter.beforeSeq) : undefined,
      filter.session ? eq(t.entry.session, filter.session) : undefined,
      filter.trajectory ? eq(t.entry.trajectory, filter.trajectory) : undefined,
      filter.kinds ? inArray(t.entry.kind, [...filter.kinds]) : undefined,
      filter.by ? sql`(${t.entry.by} = ${filter.by} OR ${t.entry.member} = ${filter.by})` : undefined,
      filter.sinceVersion !== undefined ? gt(t.entry.version, filter.sinceVersion) : undefined,
    ].filter((c) => c !== undefined)
    const rows = yield* database.db
      .select()
      .from(t.entry)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(filter.order === "asc" ? asc(t.entry.seq) : desc(t.entry.seq))
    return rows
      .filter((r) => !filter.key || (r.keys as string[]).some((k) => KeyOverlap.covers(filter.key!, k)) || r.to === filter.key)
      .slice(0, filter.limit ?? 200)
      .map(toInfo)
  })

export const entry = (seq: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.select().from(t.entry).where(eq(t.entry.seq, seq))
    if (!rows[0]) return yield* new Errors.NotFound({ what: "entry", id: String(seq) })
    return toInfo(rows[0])
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
    const comments = yield* log({ key, kinds: ["comment", "revert.request"] })
    return { who: yield* who(key), versions, blame, comments }
  })

export const version = (key: string, v: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.select().from(t.version).where(and(eq(t.version.key, key), eq(t.version.version, v)))
    if (!rows[0]) return yield* new Errors.NotFound({ what: "version", id: `${key}@v${v}` })
    return versionRow(rows[0])
  })

/** Whether an entry is for this session: its agent, its person, or a URL it holds or wrote. Its own entries are not. */
export const isFor = (e: Pick<Entry.Info, "kind" | "session" | "to" | "keys">, me: { session: string; address: string; handle: string; keys: ReadonlyArray<string> }) => {
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
    const rows = yield* db
      .select()
      .from(t.entry)
      .where(and(gt(t.entry.seq, cursor), inArray(t.entry.kind, ["ask", "tell", "handoff", "revert.request", "comment"])))
      .orderBy(asc(t.entry.seq))
    const items = rows.map(toInfo).filter((e) => isFor(e, { ...me, keys }))
    const head = (yield* db.select({ seq: t.entry.seq }).from(t.entry).orderBy(desc(t.entry.seq)).limit(1))[0]?.seq ?? cursor
    if (advance && head > cursor)
      yield* db.insert(t.cursor).values({ session: me.session, seq: head }).onConflictDoUpdate({ target: t.cursor.session, set: { seq: head } })
    return { items, cursor: head }
  })

/** Everything the Today screen needs. */
export const today = (since: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const trajectories = (yield* db.select().from(t.trajectory)).filter((r) => r.status === "running" || (r.endedAt ?? r.startedAt) >= since)
    const presence = yield* db.select().from(t.presence)
    const writes = yield* db.select({ trajectory: t.entry.trajectory }).from(t.entry).where(and(eq(t.entry.kind, "write"), gt(t.entry.at, since)))
    const entries = (yield* db
      .select()
      .from(t.entry)
      .where(and(gt(t.entry.at, since), sql`${t.entry.kind} NOT IN ('note', 'read', 'tool')`))
      .orderBy(desc(t.entry.seq))
      .limit(500)).map(toInfo)
    return {
      trajectories: trajectories.map((r) => ({
        id: r.id as Session.Trajectory["id"],
        session: r.session as Session.Trajectory["session"],
        intent: r.intent,
        forHandle: r.forHandle,
        forName: r.forName,
        owner: r.owner as Actor.Info,
        status: r.status as Session.Trajectory["status"],
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        steps: r.steps,
        tools: r.tools,
        writes: writes.filter((w) => w.trajectory === r.id).length,
      })),
      presence: presence.map((p) => ({ session: p.session, owner: p.owner as Actor.Info, members: p.members as Session.Member[], lastActive: p.lastActive })),
      claims: yield* allClaims,
      tasks: yield* tasks(),
      entries,
    }
  })

/** A session's events as the workspace holds them, after `aseq`, in order. */
export const sessionEvents = (session: string, after: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.select().from(t.entry).where(and(eq(t.entry.aggregate, session), gt(t.entry.aseq, after))).orderBy(asc(t.entry.aseq))
    return rows.map((r) => r.body as Entry.Event)
  })
