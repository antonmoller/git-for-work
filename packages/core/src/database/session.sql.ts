import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// The session object's tables. One object per agent session.

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
})

export const trajectory = sqliteTable("trajectory", {
  id: text("id").primaryKey(),
  intent: text("intent").notNull(),
  forHandle: text("for_handle").notNull(),
  forName: text("for_name").notNull(),
  member: text("member").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
})

/**
 * The session's own log: its events numbered by `aseq`, the session being the aggregate. `meta.flushed` holds the
 * highest aseq the workspace has confirmed; events above it are flushed by the object's alarm.
 */
export const event = sqliteTable("event", {
  aseq: integer("aseq").primaryKey(),
  id: text("id").notNull().unique(),
  at: integer("at").notNull(),
  kind: text("kind").notNull(),
  trajectory: text("trajectory"),
  member: text("member"),
  body: text("body", { mode: "json" }).notNull(),
})
