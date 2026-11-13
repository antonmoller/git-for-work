export * as Step from "./step.ts"

import { Schema } from "effect"
import { Key } from "./key.ts"
import { Millis, Seq, TrajectoryID, Version } from "./ids.ts"

export const Kind = Schema.Literals([
  "start",
  "read",
  "note",
  "tool",
  "claim",
  "release",
  "write",
  "revert",
  "comment",
  "task",
  "handoff",
  "ask",
  "tell",
  "join",
  "leave",
  "done",
  "fail",
])
export type Kind = typeof Kind.Type

/** One step in a session's log, chained by hash. `member` is who in the session wrote it. */
export const Info = Schema.Struct({
  seq: Seq,
  at: Millis,
  kind: Kind,
  trajectory: Schema.NullOr(TrajectoryID),
  member: Schema.String,
  text: Schema.NullOr(Schema.String),
  key: Schema.NullOr(Key.Value),
  title: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Version),
  /** The workspace entry this step points at. */
  entry: Schema.NullOr(Seq),
  data: Schema.NullOr(Schema.Unknown),
  prev: Schema.String,
  hash: Schema.String,
}).annotate({ identifier: "Step" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
