import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// The workspace object's tables. The entry table is the acked commit point and the outbox: entries are
// drained to the long-term log (docs/log.md) and trimmed past a hot-retention window.
// The workspace object's tables. One object per workspace: it is the only sequencer.
// JSON columns hold schema-validated values (actors, key lists); they are decoded at the edge of core.

/**
 * The workspace log: every event from every session, plus the workspace's own, in arrival order (`seq`).
 * The same shape as opencode's event table: (aggregate, aseq) is unique and contiguous per aggregate, so a session's
 * retried flush is a no-op. The columns besides `body` are there to filter on.
 */
export const entry = sqliteTable(
  "entry",
  {
    seq: integer("seq").primaryKey(),
    id: text("id").notNull().unique(),
    aggregate: text("aggregate").notNull(),
    aseq: integer("aseq").notNull(),
    at: integer("at").notNull(),
    kind: text("kind").notNull(),
    /** The actor's address, `karl/codex` or `karl`. */
    by: text("by").notNull(),
    member: text("member"),
    session: text("session"),
    trajectory: text("trajectory"),
    keys: text("keys", { mode: "json" }).notNull(),
    to: text("to"),
    version: integer("version"),
    body: text("body", { mode: "json" }).notNull(),
  },
  (t) => [
    uniqueIndex("entry_aggregate_aseq").on(t.aggregate, t.aseq),
    index("entry_session").on(t.session, t.seq),
    index("entry_trajectory").on(t.trajectory, t.seq),
    index("entry_kind").on(t.kind, t.seq),
    index("entry_to").on(t.to),
    index("entry_at").on(t.at),
  ],
)

/** The latest aseq of each aggregate. */
export const sequence = sqliteTable("sequence", {
  aggregate: text("aggregate").primaryKey(),
  aseq: integer("aseq").notNull(),
})

/** Every URL that was ever written or claimed: its current version and title. */
export const url = sqliteTable("url", {
  key: text("key").primaryKey(),
  title: text("title"),
  version: integer("version"),
  content: text("content"),
  writtenAt: integer("written_at"),
  writtenBy: text("written_by", { mode: "json" }),
  seq: integer("seq"),
})

export const version = sqliteTable(
  "version",
  {
    key: text("key").notNull(),
    version: integer("version").notNull(),
    seq: integer("seq").notNull(),
    at: integer("at").notNull(),
    actor: text("actor", { mode: "json" }).notNull(),
    session: text("session"),
    trajectory: text("trajectory"),
    intent: text("intent"),
    why: text("why"),
    base: integer("base"),
    content: text("content").notNull(),
    changed: text("changed", { mode: "json" }).notNull(),
    before: text("before", { mode: "json" }).notNull(),
    after: text("after", { mode: "json" }).notNull(),
    revertOf: integer("revert_of"),
    reads: text("reads", { mode: "json" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.version] })],
)

/** The current value of each field of each URL, and the version that last changed it. */
export const field = sqliteTable(
  "field",
  {
    key: text("key").notNull(),
    field: text("field").notNull(),
    value: text("value"),
    version: integer("version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.field] })],
)

export const claim = sqliteTable(
  "claim",
  {
    key: text("key").primaryKey(),
    title: text("title"),
    session: text("session").notNull(),
    trajectory: text("trajectory"),
    intent: text("intent"),
    holder: text("holder", { mode: "json" }).notNull(),
    member: text("member").notNull(),
    since: integer("since").notNull(),
    lastActive: integer("last_active").notNull(),
  },
  (t) => [index("claim_session").on(t.session)],
)

export const waiter = sqliteTable("waiter", {
  id: integer("id").primaryKey(),
  keys: text("keys", { mode: "json" }).notNull(),
  titles: text("titles", { mode: "json" }).notNull(),
  session: text("session").notNull(),
  trajectory: text("trajectory"),
  intent: text("intent"),
  actor: text("actor", { mode: "json" }).notNull(),
  member: text("member").notNull(),
  since: integer("since").notNull(),
  deadline: integer("deadline").notNull(),
  status: text("status").notNull(),
  seq: integer("seq"),
})

export const task = sqliteTable("task", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  createdBy: text("created_by", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull(),
  from: text("from_trajectory"),
  to: text("to"),
  taker: text("taker", { mode: "json" }),
  takenAt: integer("taken_at"),
  doneAt: integer("done_at"),
})

/** Trajectories that touched this workspace, for Today's lanes. The session object holds their steps. */
export const trajectory = sqliteTable("trajectory", {
  id: text("id").primaryKey(),
  session: text("session").notNull(),
  intent: text("intent").notNull(),
  owner: text("owner", { mode: "json" }).notNull(),
  forHandle: text("for_handle").notNull(),
  forName: text("for_name").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  steps: integer("steps").notNull(),
  tools: integer("tools").notNull(),
  writes: integer("writes").notNull(),
})

/** Who is in each session right now, as the session object last reported it. */
export const presence = sqliteTable("presence", {
  session: text("session").primaryKey(),
  owner: text("owner", { mode: "json" }).notNull(),
  members: text("members", { mode: "json" }).notNull(),
  lastActive: integer("last_active").notNull(),
})

/** How far each session has read its inbox. */
export const cursor = sqliteTable("cursor", {
  session: text("session").primaryKey(),
  seq: integer("seq").notNull(),
})

/** Where the drain to the long-term log stands. One row, id 1. */
export const drain = sqliteTable("drain", {
  id: integer("id").primaryKey(),
  seq: integer("seq").notNull(),
  hash: text("hash").notNull(),
  inFlight: integer("in_flight").notNull(),
  updatedAt: integer("updated_at").notNull(),
})
