import { HttpApiMiddleware } from "effect/http-api"
import { Errors } from "@work/schema/errors"
import type { Caller } from "./caller.ts"

/** Verifies the AuthKit token (bearer or cookie) and provides the caller. */
export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Caller.Current }>()("@work/protocol/Authorization", {
  error: [Errors.Unauthorized, Errors.Forbidden],
}) {}
