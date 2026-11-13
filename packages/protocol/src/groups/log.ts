import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Entry } from "@work/schema/entry"
import { Views } from "@work/schema/views"
import { common, params, ws } from "./common.ts"

export const LogGroup = HttpApiGroup.make("log")
  .add(
    HttpApiEndpoint.get("log", ws("/log"), {
      params,
      query: {
        url: Schema.optional(Schema.String),
        sinceVersion: Schema.optional(Schema.NumberFromString),
        sinceSeq: Schema.optional(Schema.NumberFromString),
        by: Schema.optional(Schema.String),
        session: Schema.optional(Schema.String),
        trajectory: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.NumberFromString),
      },
      success: Schema.Array(Entry.Info),
      error: [...common],
    }),
  )
  .add(HttpApiEndpoint.get("entry", ws("/entries/:seq"), { params: { ...params, seq: Schema.NumberFromString }, success: Entry.Info, error: [...common] }))
  .add(
    HttpApiEndpoint.get("inbox", ws("/inbox"), {
      params,
      query: { peek: Schema.optional(Schema.String) },
      success: Schema.Struct({ items: Schema.Array(Entry.Info), cursor: Schema.Int }),
      error: [...common],
    }),
  )
  .add(HttpApiEndpoint.get("today", ws("/today"), { params, query: { since: Schema.optional(Schema.NumberFromString) }, success: Views.Today, error: [...common] }))
  .add(HttpApiEndpoint.get("blob", ws("/blobs/:hash"), { params: { ...params, hash: Schema.String }, success: Schema.Struct({ content: Schema.String }), error: [...common] }))
