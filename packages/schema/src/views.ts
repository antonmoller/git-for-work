export * as Views from "./views.ts"

import { Schema } from "effect"
import { Info as Actor } from "./actor.ts"
import { Info as Claim, Who } from "./claim.ts"
import { Event, Info as Entry } from "./entry.ts"
import { Millis } from "./ids.ts"
import { Member, Trajectory } from "./session.ts"
import { Info as Task } from "./task.ts"
import { BlameLine, Version_ } from "./write.ts"

export const Workspace = Schema.Struct({ slug: Schema.String, name: Schema.String, createdAt: Millis }).annotate({ identifier: "Workspace" })
export interface Workspace extends Schema.Schema.Type<typeof Workspace> {}

export const Me = Schema.Struct({
  actor: Actor,
  email: Schema.String,
  org: Schema.String,
  role: Schema.String,
  workspaces: Schema.Array(Workspace),
}).annotate({ identifier: "Me" })
export interface Me extends Schema.Schema.Type<typeof Me> {}

export const SessionPresence = Schema.Struct({
  session: Schema.String,
  owner: Actor,
  members: Schema.Array(Member),
  lastActive: Millis,
}).annotate({ identifier: "SessionPresence" })

export const Today = Schema.Struct({
  trajectories: Schema.Array(Trajectory),
  presence: Schema.Array(SessionPresence),
  claims: Schema.Array(Claim),
  tasks: Schema.Array(Task),
  entries: Schema.Array(Entry),
}).annotate({ identifier: "Today" })
export interface Today extends Schema.Schema.Type<typeof Today> {}

export const History = Schema.Struct({
  who: Who,
  versions: Schema.Array(Version_),
  blame: Schema.Array(BlameLine),
  comments: Schema.Array(Entry),
}).annotate({ identifier: "History" })
export interface History extends Schema.Schema.Type<typeof History> {}

/** A session as its object sees it: its own log (including what is not flushed yet) and who is in it now. */
export const SessionView = Schema.Struct({
  session: Schema.String,
  owner: Schema.NullOr(Actor),
  trajectories: Schema.Array(Trajectory),
  events: Schema.Array(Event),
  members: Schema.Array(Member),
  flushed: Schema.Int,
}).annotate({ identifier: "SessionView" })
export interface SessionView extends Schema.Schema.Type<typeof SessionView> {}
