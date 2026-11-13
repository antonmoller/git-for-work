import { env as rawEnv } from "cloudflare:workers"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api, Caller } from "@work/protocol"
import { Auth } from "./auth.ts"
import { type Env, names, stub } from "./env.ts"
import { handlers } from "./handlers.ts"
import type { Scope } from "./objects/session.ts"

export { OrganizationObject } from "./objects/organization.ts"
export { SessionObject } from "./objects/session.ts"
export { WorkspaceObject } from "./objects/workspace.ts"

const env = rawEnv as unknown as Env

const api = HttpRouter.toWebHandler(HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)), {
  disableLogger: false,
})

const AUTHORIZE = "https://api.workos.com/user_management/authorize"
const AUTHENTICATE = "https://api.workos.com/user_management/authenticate"

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const challenge = async (verifier: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))

const secure = (url: URL) => url.protocol === "https:"

/** Sets the session cookies from a WorkOS authenticate response. */
const signedIn = (url: URL, tokens: { access_token: string; refresh_token: string }, location: string) => {
  const headers = new Headers({ location })
  headers.append("set-cookie", Auth.setCookie(Auth.ACCESS_COOKIE, tokens.access_token, { maxAge: 60 * 60 * 24, secure: secure(url) }))
  headers.append("set-cookie", Auth.setCookie(Auth.REFRESH_COOKIE, tokens.refresh_token, { maxAge: 60 * 60 * 24 * 30, path: "/auth", secure: secure(url) }))
  headers.append("set-cookie", Auth.setCookie(Auth.VERIFIER_COOKIE, "", { maxAge: 0, path: "/auth", secure: secure(url) }))
  return new Response(null, { status: 302, headers })
}

async function authenticate(body: Record<string, string>) {
  const response = await fetch(AUTHENTICATE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.WORKOS_CLIENT_ID, ...(env.WORKOS_API_KEY ? { client_secret: env.WORKOS_API_KEY } : {}), ...body }),
  })
  const result = (await response.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string; message?: string }
  if (!response.ok || !result.access_token || !result.refresh_token) return { ok: false as const, message: result.error_description ?? result.message ?? result.error ?? "WorkOS refused the sign-in" }
  return { ok: true as const, tokens: { access_token: result.access_token, refresh_token: result.refresh_token } }
}

/** Browser sign-in with AuthKit: PKCE, so the Worker needs no client secret. */
async function auth(request: Request, url: URL) {
  switch (url.pathname) {
    case "/auth/login": {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const state = base64url(crypto.getRandomValues(new Uint8Array(16)))
      const back = url.searchParams.get("next") ?? "/"
      const target = new URL(AUTHORIZE)
      target.searchParams.set("client_id", env.WORKOS_CLIENT_ID)
      target.searchParams.set("redirect_uri", new URL("/auth/callback", env.PUBLIC_URL || url.origin).toString())
      target.searchParams.set("response_type", "code")
      target.searchParams.set("provider", "authkit")
      target.searchParams.set("code_challenge", await challenge(verifier))
      target.searchParams.set("code_challenge_method", "S256")
      target.searchParams.set("state", `${state}.${base64url(new TextEncoder().encode(back.startsWith("/") ? back : "/"))}`)
      const headers = new Headers({ location: target.toString() })
      headers.append("set-cookie", Auth.setCookie(Auth.VERIFIER_COOKIE, `${state}.${verifier}`, { maxAge: 600, path: "/auth", secure: secure(url) }))
      return new Response(null, { status: 302, headers })
    }
    case "/auth/callback": {
      const code = url.searchParams.get("code")
      const [state, next] = (url.searchParams.get("state") ?? "").split(".")
      const [expected, verifier] = (Auth.cookie(request, Auth.VERIFIER_COOKIE) ?? "").split(".")
      if (!code || !state || state !== expected || !verifier) return new Response("The sign-in expired; start again at /auth/login", { status: 400 })
      const result = await authenticate({ grant_type: "authorization_code", code, code_verifier: verifier })
      if (!result.ok) return new Response(result.message, { status: 401 })
      const back = next ? new TextDecoder().decode(Uint8Array.from(atob(next.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))) : "/"
      return signedIn(url, result.tokens, back.startsWith("/") ? back : "/")
    }
    case "/auth/refresh": {
      if (request.method !== "POST") return new Response("Use POST", { status: 405 })
      const refresh = Auth.cookie(request, Auth.REFRESH_COOKIE)
      if (!refresh) return json({ ok: false }, 401)
      const result = await authenticate({ grant_type: "refresh_token", refresh_token: refresh })
      if (!result.ok) return json({ ok: false, message: result.message }, 401)
      const response = signedIn(url, result.tokens, "/")
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: [...response.headers].filter(([k]) => k === "set-cookie").concat([["content-type", "application/json"]]) })
    }
    case "/auth/logout": {
      const headers = new Headers({ location: "/" })
      headers.append("set-cookie", Auth.setCookie(Auth.ACCESS_COOKIE, "", { maxAge: 0, secure: secure(url) }))
      headers.append("set-cookie", Auth.setCookie(Auth.REFRESH_COOKIE, "", { maxAge: 0, path: "/auth", secure: secure(url) }))
      return new Response(null, { status: 302, headers })
    }
    case "/auth/dev": {
      // Local development only: sign in as anyone, with no WorkOS. Refused on any deployed stage.
      if (env.DEV_AUTH !== "1" || !["localhost", "127.0.0.1"].includes(url.hostname)) return new Response("Not found", { status: 404 })
      const handle = url.searchParams.get("as") ?? "anton"
      const token = Auth.devToken({
        sub: `user_${handle}`,
        email: `${handle}@example.com`,
        name: handle[0]!.toUpperCase() + handle.slice(1),
        org: url.searchParams.get("org") ?? "org_dev",
        role: url.searchParams.get("role") ?? "admin",
      })
      if (url.searchParams.get("format") === "token") return json({ token })
      const headers = new Headers({ location: url.searchParams.get("next") ?? "/" })
      headers.append("set-cookie", Auth.setCookie(Auth.ACCESS_COOKIE, token, { maxAge: 60 * 60 * 24, secure: false }))
      return new Response(null, { status: 302, headers })
    }
  }
  return new Response("Not found", { status: 404 })
}

const WATCH = /^\/api\/w\/([a-z0-9-]+)\/watch$/
const PRESENCE = /^\/api\/w\/([a-z0-9-]+)\/sessions\/([^/]+)\/socket$/

/** WebSockets: the Worker checks the caller, then hands the socket to the object that holds it. */
async function socket(request: Request, url: URL) {
  if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 })
  const who = await Auth.identify(env, request)
  if (!who.ok) return new Response(who.message, { status: who.status })
  const org = who.person.org
  const watch = url.pathname.match(WATCH)
  const presence = url.pathname.match(PRESENCE)
  const slug = (watch ?? presence)![1]!
  const list = await stub(env.ORGANIZATION, names.organization(org)).workspaces()
  if (!list.some((w) => w.slug === slug)) return new Response("No such workspace", { status: 404 })
  if (watch) return env.WORKSPACE.get(env.WORKSPACE.idFromName(names.workspace(org, slug))).fetch(request)
  const session = decodeURIComponent(presence![2]!)
  const agent = request.headers.get(Caller.headers.agent) ?? url.searchParams.get("agent")
  const actor = Auth.actor(who.person, agent)
  const scope: Scope = { org, workspace: slug, session }
  const forward = new Request(request.url, request)
  forward.headers.set("x-work-scope", JSON.stringify(scope))
  forward.headers.set("x-work-member", JSON.stringify({ actor, kind: actor.agent ? "agent" : "person" }))
  return env.SESSION.get(env.SESSION.idFromName(names.session(org, slug, session))).fetch(forward)
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/auth/")) return auth(request, url)
    if (url.pathname === "/api/config")
      return json({ clientId: env.WORKOS_CLIENT_ID, stage: env.STAGE, publicUrl: env.PUBLIC_URL || url.origin, devAuth: env.DEV_AUTH === "1" && ["localhost", "127.0.0.1"].includes(url.hostname) })
    if (WATCH.test(url.pathname) || PRESENCE.test(url.pathname)) return socket(request, url)
    if (url.pathname.startsWith("/api/")) return api.handler(request)
    if (env.ASSETS) return env.ASSETS.fetch(request)
    return new Response("Not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
