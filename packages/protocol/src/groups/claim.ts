import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Claim } from "@work/schema/claim"
import { Entry } from "@work/schema/entry"
import { Errors } from "@work/schema/errors"
import { common, params, UrlRef, ws } from "./common.ts"

export const ClaimGroup = HttpApiGroup.make("claim")
  .add(
    HttpApiEndpoint.post("claim", ws("/claims"), {
      params,
      payload: Schema.Struct({ urls: Schema.Array(UrlRef), wait: Schema.optional(Schema.Int) }),
      success: Claim.Result,
      error: [...common, Errors.KeyHeld],
    }),
  )
  .add(
    HttpApiEndpoint.post("release", ws("/claims/release"), {
      params,
      payload: Schema.Struct({ urls: Schema.Array(Schema.String) }),
      success: Schema.Struct({ released: Schema.Array(Schema.String), granted: Schema.Array(Schema.Struct({ waiter: Schema.Int, session: Schema.String, seq: Schema.Int })) }),
      error: [...common],
    }),
  )
  .add(
    HttpApiEndpoint.get("waiter", ws("/claims/waiters/:waiter"), {
      params: { ...params, waiter: Schema.NumberFromString },
      success: Schema.Struct({ status: Schema.Literals(["waiting", "granted", "expired", "cancelled"]), seq: Schema.NullOr(Schema.Int), deadline: Schema.Int, entry: Schema.NullOr(Entry.Info) }),
      error: [...common],
    }),
  )
  .add(
    HttpApiEndpoint.post("cancelWait", ws("/claims/waiters/:waiter/cancel"), {
      params: { ...params, waiter: Schema.NumberFromString },
      /** Granted when the keys were handed over before the cancel: the caller holds them and must release them. */
      success: Schema.Struct({ status: Schema.Literals(["waiting", "granted", "expired", "cancelled"]), seq: Schema.NullOr(Schema.Int), deadline: Schema.Int }),
      error: [...common],
    }),
  )
  .add(HttpApiEndpoint.get("who", ws("/who"), { params, query: { url: Schema.String }, success: Claim.Who, error: [...common] }))
