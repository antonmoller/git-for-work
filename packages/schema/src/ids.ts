export * as Ids from "./ids.ts"

import { Schema } from "effect"

/** A workspace, named `<org-slug>/<workspace-slug>` in the CLI and `holm/purchasing` in URLs. */
export const WorkspaceSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)).pipe(
  Schema.brand("WorkspaceSlug"),
)
export type WorkspaceSlug = typeof WorkspaceSlug.Type

/** An agent session, named by the session ID its hooks pass to `work`. */
export const SessionID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)).pipe(
  Schema.brand("SessionID"),
)
export type SessionID = typeof SessionID.Type

export const TrajectoryID = Schema.String.check(Schema.isPattern(/^t_[A-Za-z0-9]{4,32}$/)).pipe(
  Schema.brand("TrajectoryID"),
)
export type TrajectoryID = typeof TrajectoryID.Type

/** A WorkOS user ID. */
export const PersonID = Schema.String.pipe(Schema.brand("PersonID"))
export type PersonID = typeof PersonID.Type

/** Position in a log. Starts at 1. */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export type Seq = typeof Seq.Type

/** A URL's version. v1 is the first write. */
export const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export type Version = typeof Version.Type

/** Milliseconds since the epoch. */
export const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type Millis = typeof Millis.Type
