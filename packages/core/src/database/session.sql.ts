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

export const step = sqliteTable("step", {
  seq: integer("seq").primaryKey(),
  at: integer("at").notNull(),
  kind: text("kind").notNull(),
  trajectory: text("trajectory"),
  member: text("member").notNull(),
  text: text("text"),
  key: text("key"),
  title: text("title"),
  version: integer("version"),
  entry: integer("entry"),
  data: text("data", { mode: "json" }),
  prev: text("prev").notNull(),
  hash: text("hash").notNull(),
})
