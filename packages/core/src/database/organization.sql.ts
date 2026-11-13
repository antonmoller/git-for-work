import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// The organization object's tables. One object per WorkOS organization.

export const workspace = sqliteTable("workspace", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
  rules: text("rules", { mode: "json" }).notNull(),
})

/** FGA decisions, cached briefly so the hot path does not call WorkOS. */
export const access = sqliteTable("access", {
  id: text("id").primaryKey(),
  allowed: integer("allowed").notNull(),
  expiresAt: integer("expires_at").notNull(),
})

/** Names and emails of people, from WorkOS, so entries can say "Karl Svensson" without asking WorkOS each time. */
export const person = sqliteTable("person", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  handle: text("handle").notNull(),
  updatedAt: integer("updated_at").notNull(),
})
