export * as WorkClient from "./client.ts"

import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api, Caller } from "@work/protocol"

/** How to reach the Worker and who is calling. The browser leaves `token` out and signs in with its cookie. */
export interface Options {
  readonly baseUrl: string
  /** The access token, fetched per call so a refreshed one is used. */
  readonly token?: () => string | null | Promise<string | null>
  /** The agent's name (`codex`, `claude`): set by the CLI, never by the browser. */
  readonly agent?: string | null
  /** The session the agent writes to: its own, or one it joined. */
  readonly session?: string | null
  /** The agent's own session, when it writes to a joined one. Its inbox follows this one. */
  readonly ownSession?: string | null
}

export type Client = HttpApiClient.ForApi<typeof Api>

const headers = (options: Options) =>
  Effect.gen(function* () {
    const token = options.token ? yield* Effect.promise(async () => options.token!()) : null
    return {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.agent ? { [Caller.headers.agent]: options.agent } : {}),
      ...(options.session ? { [Caller.headers.session]: options.session } : {}),
      ...(options.ownSession ? { [Caller.headers.ownSession]: options.ownSession } : {}),
    } as Record<string, string>
  })

/** The typed client, as an Effect. Needs an `HttpClient`: `FetchHttpClient.layer` works in Bun and the browser. */
export const make = (options: Options) =>
  HttpApiClient.make(Api, {
    baseUrl: options.baseUrl,
    transformClient: HttpClient.mapRequestEffect((request) => Effect.map(headers(options), (h) => HttpClientRequest.setHeaders(request, h))),
  })

export const layer = FetchHttpClient.layer

/**
 * The promise flavour, for the web app and scripts: `const work = connect(options)`, then
 * `await work.run((c) => c.log.today({ params: { workspace }, query: {} }))`. `run` rejects with the typed error;
 * `exit` resolves to an `Exit` instead.
 */
export const connect = (options: Options) => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(FetchHttpClient.layer))
  let client: Promise<Client> | null = null
  const ready = () => (client ??= runtime.runPromise(make(options)))
  return {
    run: async <A, E>(f: (client: Client) => Effect.Effect<A, E>) => {
      const exit = await runtime.runPromiseExit(f(await ready()))
      if (Exit.isSuccess(exit)) return exit.value
      const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
      throw failure && failure._tag === "Fail" ? failure.error : new Error(String(exit.cause))
    },
    exit: async <A, E>(f: (client: Client) => Effect.Effect<A, E>) => runtime.runPromiseExit(f(await ready())),
    dispose: () => runtime.dispose(),
  }
}
