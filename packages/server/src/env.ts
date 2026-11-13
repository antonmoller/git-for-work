import type { OrganizationObject } from "./objects/organization.ts"
import type { SessionObject } from "./objects/session.ts"
import type { WorkspaceObject } from "./objects/workspace.ts"

/** The Worker's bindings, as services/api/wrangler.jsonc declares them. */
export interface Env {
  readonly ORGANIZATION: DurableObjectNamespace<OrganizationObject>
  readonly WORKSPACE: DurableObjectNamespace<WorkspaceObject>
  readonly SESSION: DurableObjectNamespace<SessionObject>
  readonly BLOBS: R2Bucket
  readonly ASSETS?: Fetcher
  readonly STAGE: string
  readonly PUBLIC_URL: string
  readonly WORKOS_CLIENT_ID: string
  /** Optional: lets the Worker look up names and emails of people. Set with `wrangler secret put`. */
  readonly WORKOS_API_KEY?: string
  /** "1" only in local development: accepts unsigned dev tokens from localhost. Never set on a deployed stage. */
  readonly DEV_AUTH?: string
}

/** Object names. One organization per WorkOS organization, one workspace per workspace, one session per agent session. */
export const names = {
  organization: (org: string) => org,
  workspace: (org: string, workspace: string) => `${org}/${workspace}`,
  session: (org: string, workspace: string, session: string) => `${org}/${workspace}/${session}`,
}

/** R2 keys. Content is stored once per hash, never overwritten. */
export const blobKey = (org: string, workspace: string, hash: string) => `ws/${org}/${workspace}/blobs/${hash}`

/**
 * A Durable Object stub typed as the class's own public methods. Cloudflare's stub types turn values with `unknown`
 * fields into `unknown`; ours cross as structured clones of plain data, so the class's own types hold.
 */
export type Stub<T> = {
  readonly [K in keyof T as T[K] extends (...args: never) => unknown ? K : never]: T[K] extends (...args: infer P) => infer R ? (...args: P) => Promise<Awaited<R>> : never
}

export const stub = <T extends Rpc.DurableObjectBranded>(namespace: DurableObjectNamespace<T>, name: string) =>
  namespace.get(namespace.idFromName(name)) as unknown as Stub<T>
