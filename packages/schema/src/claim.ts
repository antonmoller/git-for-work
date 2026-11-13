export * as Claim from "./claim.ts"

import { Schema } from "effect"
import { Info as Actor } from "./actor.ts"
import { Key } from "./key.ts"
import { Millis, SessionID, TrajectoryID, Version } from "./ids.ts"

/** One writer per key. Claims belong to the session; every member of a joined session shares them. */
export const Info = Schema.Struct({
  key: Key.Value,
  title: Schema.NullOr(Schema.String),
  session: SessionID,
  trajectory: Schema.NullOr(TrajectoryID),
  intent: Schema.NullOr(Schema.String),
  holder: Actor,
  member: Schema.String,
  since: Millis,
  lastActive: Millis,
}).annotate({ identifier: "Claim" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Waiter = Schema.Struct({
  id: Schema.Int,
  keys: Schema.Array(Key.Value),
  session: SessionID,
  actor: Actor,
  since: Millis,
  deadline: Millis,
}).annotate({ identifier: "Claim.Waiter" })
export interface Waiter extends Schema.Schema.Type<typeof Waiter> {}

/** Who holds a URL, who waits, and its current version. */
export const Who = Schema.Struct({
  key: Key.Value,
  title: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Version),
  writtenAt: Schema.NullOr(Millis),
  writtenBy: Schema.NullOr(Actor),
  holders: Schema.Array(Info),
  waiters: Schema.Array(Waiter),
}).annotate({ identifier: "Claim.Who" })
export interface Who extends Schema.Schema.Type<typeof Who> {}

export const Result = Schema.Union([
  Schema.TaggedStruct("Claimed", { keys: Schema.Array(Key.Value), seq: Schema.Int }),
  Schema.TaggedStruct("Held", { conflicts: Schema.Array(Info) }),
  Schema.TaggedStruct("Waiting", { waiter: Schema.Int, conflicts: Schema.Array(Info), deadline: Millis }),
])
export type Result = typeof Result.Type
