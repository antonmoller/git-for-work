import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Errors } from "@work/schema/errors"
import { Views } from "@work/schema/views"

export const AccountGroup = HttpApiGroup.make("account")
  .add(HttpApiEndpoint.get("me", "/api/me", { success: Views.Me }))
  .add(
    HttpApiEndpoint.post("createWorkspace", "/api/workspaces", {
      payload: Schema.Struct({ slug: Schema.String, name: Schema.String }),
      success: Views.Workspace,
      error: [Errors.Invalid, Errors.NotFound],
    }),
  )
