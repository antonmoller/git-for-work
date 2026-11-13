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
  "trajectory.start",
  "trajectory.end",
  "read",
  "note",
  "tool",
  "join",
  "leave",
  "refused",
])
export type Kind = typeof Kind.Type

/** The aggregate for events no session owns: comments from the browser, expiries, grants to waiters. */
export const WORKSPACE = "workspace"

/**
 * One thing that happened, as both objects store it. Events belong to an aggregate (an agent session, or the
 * workspace) and are numbered contiguously within it by `aseq`. A session's events carry the same aggregate and aseq
 * in the session object and in the workspace object, which is how a retried flush is recognised.
 */
export const Event = Schema.Struct({
  id: Schema.String,
  aggregate: Schema.String,
  aseq: Seq,
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
  /** The entry this one answers or comments on, by workspace seq. */
  ref: Schema.NullOr(Seq),
  task: Schema.NullOr(Schema.Int),
  /** Extra detail: a tool call's name, a refusal's reason, who a trajectory is for. */
  data: Schema.NullOr(Schema.Unknown),
}).annotate({ identifier: "Entry.Event" })
export interface Event extends Schema.Schema.Type<typeof Event> {}

/** An event in the workspace log, with its position in arrival order across all aggregates. */
export const Info = Schema.Struct({ ...Event.fields, seq: Seq }).annotate({ identifier: "Entry" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
