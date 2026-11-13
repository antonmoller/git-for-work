export * as Session from "./session.ts"

import { Schema } from "effect"
import { Info as Actor } from "./actor.ts"
import { Millis, SessionID, TrajectoryID } from "./ids.ts"

export const MemberKind = Schema.Literals(["agent", "person"])

/** Someone in a session right now. Each live WebSocket's attachment is one of these. */
export const Member = Schema.Struct({
  id: Schema.String,
  kind: MemberKind,
  address: Schema.String,
  label: Schema.String,
  person: Schema.String,
  since: Millis,
  owner: Schema.Boolean,
}).annotate({ identifier: "Session.Member" })
export interface Member extends Schema.Schema.Type<typeof Member> {}

export const Presence = Schema.Struct({
  session: SessionID,
  members: Schema.Array(Member),
}).annotate({ identifier: "Session.Presence" })
export interface Presence extends Schema.Schema.Type<typeof Presence> {}

export const Trajectory = Schema.Struct({
  id: TrajectoryID,
  session: SessionID,
  intent: Schema.String,
  /** The person the agent works for. */
  forHandle: Schema.String,
  forName: Schema.String,
  owner: Actor,
  status: Schema.Literals(["running", "done", "failed"]),
  startedAt: Millis,
  endedAt: Schema.NullOr(Millis),
  steps: Schema.Int,
  tools: Schema.Int,
  writes: Schema.Int,
}).annotate({ identifier: "Session.Trajectory" })
export interface Trajectory extends Schema.Schema.Type<typeof Trajectory> {}

export const Info = Schema.Struct({
  id: SessionID,
  owner: Actor,
  host: Schema.NullOr(Schema.String),
  createdAt: Millis,
  lastActive: Millis,
}).annotate({ identifier: "Session" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
