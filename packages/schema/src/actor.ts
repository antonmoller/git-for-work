export * as Actor from "./actor.ts"

import { Schema } from "effect"
import { PersonID } from "./ids.ts"

/**
 * Who did something. Agents act as their person: an agent's actor carries the person and the agent's name,
 * so "karl/codex" reads "Codex for Karl". A person in the browser has no agent.
 */
export const Info = Schema.Struct({
  person: PersonID,
  handle: Schema.String,
  name: Schema.String,
  agent: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Actor" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

/** `karl/codex` for an agent, `karl` for a person. */
export const address = (actor: Pick<Info, "handle" | "agent">) =>
  actor.agent ? `${actor.handle}/${actor.agent}` : actor.handle

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "Codex for Karl" or "Karl Svensson". */
export const label = (actor: Pick<Info, "name" | "agent">) =>
  actor.agent ? `${capital(actor.agent)} for ${actor.name.split(" ")[0]}` : actor.name
