import { DurableObject } from "cloudflare:workers"
import { Layer, ManagedRuntime } from "effect"
import { Database } from "@work/core/database/database"
import { sqliteLayer, type DurableObjectStorage as SqliteStorage } from "@work/core/database/sqlite.workerd"
import { Organization } from "@work/core/organization/organization"
import type { Env } from "../env.ts"
import { Rpc } from "../rpc.ts"

/** One per WorkOS organization: its workspaces, their URL rules, and the people's names. Small and rarely written. */
export class OrganizationObject extends DurableObject<Env> {
  private readonly runtime: ManagedRuntime.ManagedRuntime<Database.Service, never>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.runtime = ManagedRuntime.make(Database.layer("organization").pipe(Layer.provide(sqliteLayer({ storage: ctx.storage as unknown as SqliteStorage }))))
  }

  workspaces() {
    return this.runtime.runPromise(Organization.workspaces).then(Rpc.plain)
  }
  createWorkspace(slug: string, name: string, by: string) {
    return Rpc.run(this.runtime.runPromiseExit(Organization.createWorkspace(slug, name, by, Date.now())))
  }
  person(id: string) {
    return this.runtime.runPromise(Organization.person(id))
  }
  savePerson(input: { id: string; email: string; name: string }) {
    return this.runtime.runPromise(Organization.savePerson(input, Date.now()))
  }
}
