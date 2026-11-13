import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// The workspace object's tables. The entry table is the acked commit point and the outbox: entries are
// drained to the long-term log (docs/log.md) and trimmed past a hot-retention window.
// The workspace object's tables. One object per workspace: it is the only sequencer.
// JSON columns hold schema-validated values (actors, key lists); they are decoded at the edge of core.

export const entry = sqliteTable(
  "entry",
  {
    seq: integer("seq").primaryKey(),
    at: integer("at").notNull(),
    kind: text("kind").notNull(),
    actor: text("actor", { mode: "json" }).notNull(),
    member: text("member"),
    session: text("session"),
    trajectory: text("trajectory"),
    keys: text("keys", { mode: "json" }).notNull(),
    title: text("title"),
    version: integer("version"),
    base: integer("base"),
    content: text("content"),
    fields: text("fields", { mode: "json" }).notNull(),
    revertOf: integer("revert_of"),
    text: text("text"),
    to: text("to"),
    ref: integer("ref"),
    task: integer("task"),
    prev: text("prev").notNull(),
    hash: text("hash").notNull(),
    /** Set once the entry is durable in the workspace's long-term log (docs/log.md). Drained rows are trimmed later. */
    drained: integer("drained").notNull().default(0),
  },
  (t) => [index("entry_drained").on(t.drained, t.seq), index("entry_session").on(t.session), index("entry_to").on(t.to), index("entry_at").on(t.at)],
)

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
