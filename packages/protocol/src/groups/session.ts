import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Entry } from "@work/schema/entry"
import { Views } from "@work/schema/views"
import { common, params, ws } from "./common.ts"

/** The agent session's own log. The session comes from the `x-work-session` header. */
export const SessionGroup = HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.post("start", ws("/session/start"), {
      params,
      payload: Schema.Struct({ intent: Schema.String, for: Schema.optional(Schema.String) }),
      success: Entry.Event,
      error: [...common],
    }),
  )
  .add(
    HttpApiEndpoint.post("step", ws("/session/step"), {
      params,
      payload: Schema.Struct({
        kind: Schema.Literals(["note", "read", "tool"]),
        text: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        title: Schema.optional(Schema.String),
        version: Schema.optional(Schema.Int),
        data: Schema.optional(Schema.Unknown),
      }),
      success: Entry.Event,
      error: [...common],
    }),
  )
  .add(
    HttpApiEndpoint.post("end", ws("/session/end"), {
      params,
      payload: Schema.Struct({ status: Schema.Literals(["done", "failed"]), why: Schema.optional(Schema.String) }),
      success: Schema.Struct({ event: Entry.Event, released: Schema.Array(Schema.String) }),
      error: [...common],
    }),
  )
  .add(HttpApiEndpoint.post("flush", ws("/session/flush"), { params, success: Schema.Struct({ flushed: Schema.Int }), error: [...common] }))
  .add(
    HttpApiEndpoint.get("view", ws("/sessions/:session"), {
      params: { ...params, session: Schema.String },
      success: Views.SessionView,
      error: [...common],
    }),
  )
  .add(
    HttpApiEndpoint.post("join", ws("/sessions/:session/join"), {
      params: { ...params, session: Schema.String },
      success: Views.SessionView,
      error: [...common],
    }),
  )
