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
