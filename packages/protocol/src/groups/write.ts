import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Entry } from "@work/schema/entry"
import { Errors } from "@work/schema/errors"
import { Views } from "@work/schema/views"
import { Write } from "@work/schema/write"
import { common, params, ws } from "./common.ts"

export const WriteResult = Schema.Struct({
  entry: Entry.Info,
  version: Schema.Int,
  changed: Schema.Array(Schema.String),
  summary: Schema.String,
  released: Schema.Array(Schema.String),
})

export const WriteGroup = HttpApiGroup.make("write")
  .add(
    HttpApiEndpoint.post("put", ws("/writes"), {
      params,
      payload: Schema.Struct({
        url: Schema.String,
        title: Schema.optional(Schema.String),
        /**
         * Omitted: the version this session last read or wrote. Null: the URL has no versions yet. Leave the key out
         * rather than passing undefined: the JSON codec sends undefined as null.
         */
        base: Schema.optional(Schema.NullOr(Schema.Int)),
        content: Schema.String,
        why: Schema.optional(Schema.String),
        revertOf: Schema.optional(Schema.Int),
      }),
      success: WriteResult,
      error: [...common, Errors.KeyHeld, Errors.StaleBase],
    }),
  )
  .add(
    HttpApiEndpoint.post("revert", ws("/reverts"), {
      params,
      payload: Schema.Struct({ url: Schema.String, version: Schema.Int, fields: Schema.optional(Schema.Array(Schema.String)) }),
      success: Write.RevertPlan,
      error: [...common, Errors.KeyHeld, Errors.RevertConflict],
    }),
  )
  .add(
    HttpApiEndpoint.post("requestRevert", ws("/revert-requests"), {
      params,
      payload: Schema.Struct({ url: Schema.String, version: Schema.Int, to: Schema.optional(Schema.String) }),
      success: Entry.Info,
      error: [...common],
    }),
  )
  .add(HttpApiEndpoint.get("history", ws("/history"), { params, query: { url: Schema.String }, success: Views.History, error: [...common] }))
  .add(
    HttpApiEndpoint.get("version", ws("/versions"), {
      params,
      query: { url: Schema.String, version: Schema.NumberFromString },
      success: Schema.Struct({ version: Write.Version_, content: Schema.NullOr(Schema.String) }),
      error: [...common],
    }),
  )
