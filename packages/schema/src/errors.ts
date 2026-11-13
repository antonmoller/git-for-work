export * as Errors from "./errors.ts"

import { Schema } from "effect"
import { Info as Actor } from "./actor.ts"
import { Info as Claim } from "./claim.ts"
import { Info as Task } from "./task.ts"
import { Millis, Version } from "./ids.ts"

/** Another session holds the URL or one above or below it. */
export class KeyHeld extends Schema.TaggedError<KeyHeld>()(
  "KeyHeld",
  { key: Schema.String, conflicts: Schema.Array(Claim) },
  { httpApiStatus: 409 },
) {}

/** The URL moved past the version the write was based on. */
export class StaleBase extends Schema.TaggedError<StaleBase>()(
  "StaleBase",
  {
    key: Schema.String,
    base: Schema.NullOr(Version),
    current: Version,
    at: Millis,
    by: Actor,
  },
  { httpApiStatus: 409 },
) {}

/**
 * The content is an earlier version's, not the base's with changes: writing it would silently undo the versions
 * since. Usually a stale copy; a deliberate undo is a revert.
 */
export class StaleContent extends Schema.TaggedError<StaleContent>()(
  "StaleContent",
  {
    key: Schema.String,
    matches: Version,
    current: Version,
  },
  { httpApiStatus: 409 },
) {}

/** A later write changed a field the revert would put back. */
export class RevertConflict extends Schema.TaggedError<RevertConflict>()(
  "RevertConflict",
  {
    key: Schema.String,
    version: Version,
    later: Version,
    fields: Schema.Array(Schema.String),
    at: Millis,
    by: Actor,
  },
  { httpApiStatus: 409 },
) {}

export class TaskTaken extends Schema.TaggedError<TaskTaken>()(
  "TaskTaken",
  { task: Task },
  { httpApiStatus: 409 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { what: Schema.String, id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class Invalid extends Schema.TaggedError<Invalid>()(
  "Invalid",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** A flushed event skipped ahead of its aggregate's sequence. Resend from `expected`. */
export class Gap extends Schema.TaggedError<Gap>()(
  "Gap",
  { aggregate: Schema.String, expected: Schema.Int, got: Schema.Int },
  { httpApiStatus: 409 },
) {}
