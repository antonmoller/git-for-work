export * as Entry from "./entry.ts"

import { Schema } from "effect"
import { Info as Actor } from "./actor.ts"
import { Key } from "./key.ts"
import { Millis, Seq, SessionID, TrajectoryID, Version } from "./ids.ts"

/** What happened, in the workspace log. Only what agents must agree on is here. */
export const Kind = Schema.Literals([
  "claim",
  "release",
  "expire",
  "write",
  "revert.request",
  "revert.start",
  "comment",
  "task.add",
  "task.take",
  "task.done",
  "handoff",
  "ask",
  "tell",
])
export type Kind = typeof Kind.Type

/**
 * One thing that happened. Appended, ordered, never edited. `hash` covers every other field and the previous
 * entry's hash, so the log is a chain.
 */
export const Info = Schema.Struct({
  seq: Seq,
  at: Millis,
  kind: Kind,
  actor: Actor,
  /** Which member of a joined session wrote it, as an address such as `anna/claude`. */
  member: Schema.NullOr(Schema.String),
  session: Schema.NullOr(SessionID),
  trajectory: Schema.NullOr(TrajectoryID),
  keys: Schema.Array(Key.Value),
  title: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Version),
  base: Schema.NullOr(Version),
  content: Schema.NullOr(Schema.String),
  fields: Schema.Array(Schema.String),
  revertOf: Schema.NullOr(Version),
  text: Schema.NullOr(Schema.String),
  /** An address (`karl/claude`), a person handle, or a key. */
  to: Schema.NullOr(Schema.String),
  /** The entry this one answers or comments on. */
  ref: Schema.NullOr(Seq),
  task: Schema.NullOr(Schema.Int),
  prev: Schema.String,
  hash: Schema.String,
}).annotate({ identifier: "Entry" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
