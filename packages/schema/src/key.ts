export * as Key from "./key.ts"

import { Schema } from "effect"

/**
 * A key is a normalized URL without its scheme: `erp.holm.se/prices/bearings-2027`.
 * Normalization lives in core (`@work/core/key/normalize`); this is the stored form.
 */
export const Value = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).pipe(Schema.brand("Key"))
export type Value = typeof Value.Type

/** A workspace's extra rule for one host's URLs. */
export const Rule = Schema.Struct({
  host: Schema.String,
  /** Query parameters to drop, on top of the tracking parameters always dropped. */
  dropParams: Schema.optional(Schema.Array(Schema.String)),
  /** When set, every other query parameter is dropped. */
  keepParams: Schema.optional(Schema.Array(Schema.String)),
  /** Drop the fragment for this host. */
  dropFragment: Schema.optional(Schema.Boolean),
  /** Trailing path segments that are views of the same thing, such as `edit`. */
  views: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Key.Rule" })
export interface Rule extends Schema.Schema.Type<typeof Rule> {}
