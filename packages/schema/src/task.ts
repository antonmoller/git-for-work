export * as Task from "./task.ts"

import { Schema } from "effect"
import { Info as Actor } from "./actor.ts"
import { Millis, TrajectoryID } from "./ids.ts"

export const Info = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  status: Schema.Literals(["open", "taken", "done"]),
  createdBy: Actor,
  createdAt: Millis,
  from: Schema.NullOr(TrajectoryID),
  /** Who it was handed to, as an address, before anyone took it. */
  to: Schema.NullOr(Schema.String),
  taker: Schema.NullOr(Actor),
  takenAt: Schema.NullOr(Millis),
  doneAt: Schema.NullOr(Millis),
}).annotate({ identifier: "Task" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
