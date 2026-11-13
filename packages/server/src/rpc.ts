export * as Rpc from "./rpc.ts"

import { Effect, Exit, Schema } from "effect"
import { Errors } from "@work/schema/errors"

/**
 * Durable Object RPC carries plain values, so typed failures cross as `{ ok: false, error }` with the error's
 * encoded form, and are decoded back into the schema's error classes on the other side. Defects throw.
 */
export type Result<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: { readonly _tag: string } }

const AnyError = Schema.Union([
  Errors.KeyHeld,
  Errors.StaleBase,
  Errors.RevertConflict,
  Errors.TaskTaken,
  Errors.NotFound,
  Errors.Invalid,
  Errors.Unauthorized,
  Errors.Forbidden,
  Errors.Gap,
])
export type AnyError = typeof AnyError.Type

const encodeError = Schema.encodeUnknownSync(AnyError)
const decodeError = Schema.decodeUnknownSync(AnyError)

/** Runs an effect inside an object and returns a plain result. */
export const run = async <A, E>(promise: Promise<Exit.Exit<A, E>>): Promise<Result<A>> => {
  const exit = await promise
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (failure && failure._tag === "Fail" && Schema.is(AnyError)(failure.error))
    return { ok: false, error: JSON.parse(JSON.stringify(encodeError(failure.error))) }
  throw new Error(`Object call failed: ${String(exit.cause)}`)
}

/** Turns a plain result from an object back into an effect with typed errors. */
export const unwrap = <A>(call: () => Promise<Result<A>>) =>
  Effect.flatMap(
    Effect.promise(() => call()),
    (result): Effect.Effect<A, AnyError> => (result.ok ? Effect.succeed(result.value) : Effect.fail(decodeError(result.error))),
  )

/** Plain JSON copy, for values crossing RPC. */
export const plain = <A>(value: A): A => JSON.parse(JSON.stringify(value))
