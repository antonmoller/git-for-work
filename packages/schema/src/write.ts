export * as Write from "./write.ts"

import { Schema } from "effect"
import { Info as Actor } from "./actor.ts"
import { Key } from "./key.ts"
import { Millis, Seq, SessionID, TrajectoryID, Version } from "./ids.ts"

/** One version of a URL. `before` and `after` hold the values of the fields it changed. */
export const Version_ = Schema.Struct({
  key: Key.Value,
  version: Version,
  seq: Seq,
  at: Millis,
  actor: Actor,
  session: Schema.NullOr(SessionID),
  trajectory: Schema.NullOr(TrajectoryID),
  intent: Schema.NullOr(Schema.String),
  why: Schema.NullOr(Schema.String),
  base: Schema.NullOr(Version),
  content: Schema.String,
  changed: Schema.Array(Schema.String),
  before: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  after: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  revertOf: Schema.NullOr(Version),
  reads: Schema.Array(Schema.String),
}).annotate({ identifier: "Write.Version" })
export interface Version_ extends Schema.Schema.Type<typeof Version_> {}

/** What `work revert` hands the agent: the values to put back, and the claim it now holds. */
export const RevertPlan = Schema.Struct({
  key: Key.Value,
  revertOf: Version,
  current: Version,
  fields: Schema.Array(Schema.String),
  /** Field values to put back; null means the field did not exist before. */
  values: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  /** The content before the reverted write, as Work holds it. */
  baseContent: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Write.RevertPlan" })
export interface RevertPlan extends Schema.Schema.Type<typeof RevertPlan> {}

/** Blame: for each field, the write that last changed it. */
export const BlameLine = Schema.Struct({
  field: Schema.String,
  version: Version,
  at: Millis,
  actor: Actor,
  trajectory: Schema.NullOr(TrajectoryID),
  value: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Write.BlameLine" })
export interface BlameLine extends Schema.Schema.Type<typeof BlameLine> {}
