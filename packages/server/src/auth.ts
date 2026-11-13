export * as Auth from "./auth.ts"

import { createRemoteJWKSet, jwtVerify } from "jose"
import type { Actor } from "@work/schema/actor"
import { type Env, names, stub } from "./env.ts"

/** A person the Worker has verified. Agents act as their person, so there are only people to sign in. */
export interface Person {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly handle: string
  readonly org: string
  readonly role: string
}

export const ACCESS_COOKIE = "work_at"
export const REFRESH_COOKIE = "work_rt"
export const VERIFIER_COOKIE = "work_pkce"

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

const keysFor = (clientId: string) => {
  const existing = jwks.get(clientId)
  if (existing) return existing
  const created = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`))
  jwks.set(clientId, created)
  return created
}

const isLocal = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)

/**
 * A local development token: `dev.<base64url JSON {sub, email, name, org, role}>`. Accepted only when DEV_AUTH is "1"
 * and the request reached the Worker on localhost, so a deployed stage never honours one.
 */
export const devToken = (claims: { sub: string; email: string; name: string; org: string; role?: string }) =>
  `dev.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`

type Claims = { sub: string; org: string | null; role: string; email: string | null; name: string | null }

async function verify(env: Env, url: URL, token: string): Promise<Claims | null> {
  if (token.startsWith("dev.")) {
    if (env.DEV_AUTH !== "1" || !isLocal(url)) return null
    const json = JSON.parse(atob(token.slice(4).replace(/-/g, "+").replace(/_/g, "/")))
    return { sub: json.sub, org: json.org, role: json.role ?? "member", email: json.email, name: json.name }
  }
  // AuthKit access tokens, checked against WorkOS's public keys, with no call to WorkOS.
  const result = await jwtVerify(token, keysFor(env.WORKOS_CLIENT_ID)).catch(() => null)
  if (!result?.payload.sub) return null
  const p = result.payload as Record<string, unknown>
  return {
    sub: String(p.sub),
    org: typeof p.org_id === "string" ? p.org_id : null,
    role: typeof p.role === "string" ? p.role : "member",
    // Present when the WorkOS JWT template adds them (see docs/setup.md).
    email: typeof p.email === "string" ? p.email : null,
    name: typeof p.name === "string" ? p.name : null,
  }
}

/** The name and email for a person: from the token, the organization's cache, or WorkOS when an API key is set. */
async function profile(env: Env, claims: Claims & { org: string }) {
  const org = stub(env.ORGANIZATION, names.organization(claims.org))
  const cached = await org.person(claims.sub)
  if (claims.email && claims.name && (cached?.row.email !== claims.email || cached?.row.name !== claims.name))
    return org.savePerson({ id: claims.sub, email: claims.email, name: claims.name })
  if (cached && Date.now() - cached.updatedAt < 24 * 60 * 60_000) return cached.row
  if (env.WORKOS_API_KEY) {
    const response = await fetch(`https://api.workos.com/user_management/users/${claims.sub}`, { headers: { authorization: `Bearer ${env.WORKOS_API_KEY}` } })
    if (response.ok) {
      const user = (await response.json()) as { email: string; first_name: string | null; last_name: string | null }
      const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email.split("@")[0]
      return org.savePerson({ id: claims.sub, email: user.email, name })
    }
  }
  if (cached) return cached.row
  return org.savePerson({ id: claims.sub, email: `${claims.sub}@unknown`, name: claims.sub })
}

export type Identified = { ok: true; person: Person } | { ok: false; status: 401 | 403; message: string }

export async function identify(env: Env, request: Request): Promise<Identified> {
  const url = new URL(request.url)
  const header = request.headers.get("authorization")
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? cookie(request, ACCESS_COOKIE)
  if (!token) return { ok: false, status: 401, message: "Sign in: run `work login`, or open the app" }
  const claims = await verify(env, url, token)
  if (!claims) return { ok: false, status: 401, message: "The sign-in has expired or is not valid; sign in again" }
  if (!claims.org) return { ok: false, status: 403, message: "Your sign-in has no organization; choose one in WorkOS and sign in again" }
  const p = await profile(env, { ...claims, org: claims.org })
  return { ok: true, person: { id: claims.sub, email: p.email, name: p.name, handle: p.handle, org: claims.org, role: claims.role } }
}

export const actor = (person: Person, agent: string | null): Actor.Info => ({
  person: person.id as Actor.Info["person"],
  handle: person.handle,
  name: person.name,
  agent: agent && /^[a-z][a-z0-9-]{0,31}$/.test(agent) ? agent : null,
})

export function cookie(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? ""
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return decodeURIComponent(v.join("="))
  }
  return null
}

export const setCookie = (name: string, value: string, options: { maxAge: number; path?: string; secure: boolean }) =>
  `${name}=${encodeURIComponent(value)}; Path=${options.path ?? "/"}; HttpOnly; SameSite=Lax; Max-Age=${options.maxAge}${options.secure ? "; Secure" : ""}`
