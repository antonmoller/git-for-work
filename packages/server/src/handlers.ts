import { env as rawEnv } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { ContentFields } from "@work/core/content/fields"
import { ContentHash } from "@work/core/content/hash"
import { KeyNormalize } from "@work/core/key/normalize"
import type { Session as SessionCore } from "@work/core/session/session"
import { Api, Authorization, Caller } from "@work/protocol"
import { Actor } from "@work/schema/actor"
import { Errors } from "@work/schema/errors"
import type { Key } from "@work/schema/key"
import { Auth } from "./auth.ts"
import { blobKey, type Env, names, stub } from "./env.ts"
import type { Scope } from "./objects/session.ts"
import { Rpc } from "./rpc.ts"

const env = rawEnv as unknown as Env

// Objects

const organization = (org: string) => stub(env.ORGANIZATION, names.organization(org))
const workspaceObject = (org: string, slug: string) => stub(env.WORKSPACE, names.workspace(org, slug))
const sessionObject = (scope: Scope) => stub(env.SESSION, names.session(scope.org, scope.workspace, scope.session))

/** Workspaces per organization, cached briefly in the isolate so most calls skip the organization object. */
const workspaceCache = new Map<string, { at: number; list: Awaited<ReturnType<ReturnType<typeof organization>["workspaces"]>> }>()

const workspaceInfo = (org: string, slug: string) =>
  Effect.gen(function* () {
    const cached = workspaceCache.get(org)
    const list = cached && Date.now() - cached.at < 30_000 && cached.list.some((w) => w.slug === slug) ? cached.list : yield* Effect.promise(() => organization(org).workspaces())
    workspaceCache.set(org, { at: Date.now(), list })
    const found = list.find((w) => w.slug === slug)
    if (!found) return yield* new Errors.NotFound({ what: "workspace", id: slug })
    return found
  })

// The caller

const current = Effect.gen(function* () {
  return yield* Caller.Current
})

/** The workspace object for a call, after checking the workspace exists. */
const workspaceFor = (slug: string) =>
  Effect.gen(function* () {
    const caller = yield* current
    const info = yield* workspaceInfo(caller.org, slug)
    return { caller, info, object: workspaceObject(caller.org, slug) }
  })

/** Calls that change something need an agent session and a role that may write. */
const sessionFor = (slug: string) =>
  Effect.gen(function* () {
    const w = yield* workspaceFor(slug)
    if (!w.caller.session) return yield* new Errors.Invalid({ message: "No agent session: run `work init claude` or `work init codex`, or pass --session" })
    if (!w.caller.actor.agent) return yield* new Errors.Invalid({ message: "Name the agent: pass --agent or run `work init`" })
    if (w.caller.role === "viewer") return yield* new Errors.Forbidden({ message: "Viewers cannot change anything" })
    const scope: Scope = { org: w.caller.org, workspace: slug, session: w.caller.session }
    const who: SessionCore.Who = { session: w.caller.session, actor: w.caller.actor, member: Actor.address(w.caller.actor), now: Date.now() }
    return { ...w, scope, who, session: sessionObject(scope) }
  })

const normalize = (url: string, rules: ReadonlyArray<Key.Rule>) =>
  Effect.try({ try: () => KeyNormalize.normalize(url, rules), catch: (e) => new Errors.Invalid({ message: (e as Error).message }) })

type Tag = Rpc.AnyError["_tag"]
type Always = "Invalid" | "NotFound" | "Unauthorized" | "Forbidden"
const always: ReadonlyArray<Tag> = ["Invalid", "NotFound", "Unauthorized", "Forbidden"]

/**
 * An object call. Failures the endpoint declares (the common ones plus `also`) stay typed; any other failure is a bug
 * here, so it becomes a defect and a 500.
 */
const call = <A, const T extends Tag = never>(f: () => Promise<Rpc.Result<A>>, ...also: ReadonlyArray<T>) =>
  Rpc.unwrap(f).pipe(
    Effect.catch((error) =>
      always.includes(error._tag) || (also as ReadonlyArray<Tag>).includes(error._tag)
        ? Effect.fail(error as Extract<Rpc.AnyError, { _tag: Always | T }>)
        : Effect.die(error),
    ),
  )

const putBlob = (org: string, workspace: string, content: string) =>
  Effect.promise(async () => {
    const hash = ContentHash.sha256(content)
    const key = blobKey(org, workspace, hash)
    // Content-addressed: an existing object already holds these bytes.
    if (!(await env.BLOBS.head(key))) await env.BLOBS.put(key, content, { httpMetadata: { contentType: "text/plain; charset=utf-8" } })
    return hash
  })

const getBlob = (org: string, workspace: string, hash: string) =>
  Effect.promise(async () => {
    const object = await env.BLOBS.get(blobKey(org, workspace, hash))
    return object ? await object.text() : null
  })

// Handlers

const AccountHandlers = HttpApiBuilder.group(Api, "account", (handlers) =>
  handlers
    .handle("me", () =>
      Effect.gen(function* () {
        const caller = yield* current
        const list = yield* Effect.promise(() => organization(caller.org).workspaces())
        return {
          actor: caller.actor,
          email: caller.email,
          org: caller.org,
          role: caller.role,
          workspaces: list.map((w) => ({ slug: w.slug, name: w.name, createdAt: w.createdAt })),
        }
      }),
    )
    .handle("createWorkspace", (ctx) =>
      Effect.gen(function* () {
        const caller = yield* current
        if (caller.role !== "admin" && env.DEV_AUTH !== "1") return yield* new Errors.Forbidden({ message: "Only an admin can create a workspace" })
        workspaceCache.delete(caller.org)
        return yield* call(() => organization(caller.org).createWorkspace(ctx.payload.slug, ctx.payload.name, caller.actor.person))
      }),
    ),
)

const SessionHandlers = HttpApiBuilder.group(Api, "session", (handlers) =>
  handlers
    .handle("start", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        const forHandle = ctx.payload.for ?? s.caller.actor.handle
        const id = `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
        return yield* call(() =>
          s.session.start(s.scope, s.who, { id, intent: ctx.payload.intent, forHandle, forName: forHandle === s.caller.actor.handle ? s.caller.actor.name : forHandle }),
        )
      }),
    )
    .handle("step", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        const key = ctx.payload.url ? yield* normalize(ctx.payload.url, s.info.rules) : null
        const version = ctx.payload.version ?? (key && ctx.payload.kind === "read" ? (yield* call(() => s.object.who(key))).version : null)
        return yield* call(() =>
          s.session.record(s.scope, s.who, {
            kind: ctx.payload.kind,
            text: ctx.payload.text ?? null,
            keys: key ? [key] : [],
            title: ctx.payload.title ?? null,
            version: version ?? null,
            data: ctx.payload.data ?? null,
          }),
        )
      }),
    )
    .handle("end", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        return yield* call(() => s.session.end(s.scope, s.who, ctx.payload.status, ctx.payload.why ?? null))
      }),
    )
    .handle("flush", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        return yield* call(() => s.session.flush(s.scope))
      }),
    )
    .handle("view", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        return yield* call(() => sessionObject({ org: w.caller.org, workspace: ctx.params.workspace, session: ctx.params.session }).view({ org: w.caller.org, workspace: ctx.params.workspace, session: ctx.params.session }))
      }),
    )
    .handle("join", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const scope = { org: w.caller.org, workspace: ctx.params.workspace, session: ctx.params.session }
        const view = yield* call(() => sessionObject(scope).view(scope))
        if (!view.owner) return yield* new Errors.NotFound({ what: "session", id: ctx.params.session })
        return view
      }),
    ),
)

const ClaimHandlers = HttpApiBuilder.group(Api, "claim", (handlers) =>
  handlers
    .handle("claim", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        const keys = yield* Effect.forEach(ctx.payload.urls, (u) => Effect.map(normalize(u.url, s.info.rules), (key) => ({ key: key as string, title: u.title ?? null })))
        return yield* call(() => s.session.claim(s.scope, s.who, keys, ctx.payload.wait ?? 0), "KeyHeld")
      }),
    )
    .handle("release", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        const keys = yield* Effect.forEach(ctx.payload.urls, (u) => normalize(u, s.info.rules))
        const result = yield* call(() => s.session.release(s.scope, s.who, keys))
        return { released: result.released, granted: result.granted }
      }),
    )
    .handle("waiter", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        return yield* call(() => w.object.waiter(ctx.params.waiter))
      }),
    )
    .handle("cancelWait", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        yield* call(() => s.object.cancelWait(s.scope.session, ctx.params.waiter))
      }),
    )
    .handle("who", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const key = yield* normalize(ctx.query.url, w.info.rules)
        return yield* call(() => w.object.who(key))
      }),
    ),
)

const WriteHandlers = HttpApiBuilder.group(Api, "write", (handlers) =>
  handlers
    .handle("put", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        const key = yield* normalize(ctx.payload.url, s.info.rules)
        const base = ctx.payload.base !== undefined ? ctx.payload.base : ((yield* call(() => s.session.lastRead(s.scope, key))) ?? null)
        const hash = yield* putBlob(s.caller.org, ctx.params.workspace, ctx.payload.content)
        const fields = ContentFields.parse(ctx.payload.content)
        const result = yield* call(() =>
          s.session.write(s.scope, s.who, { key, title: ctx.payload.title ?? null, base, content: hash, fields, why: ctx.payload.why ?? null, revertOf: ctx.payload.revertOf ?? null, reads: [] }),
          "KeyHeld",
          "StaleBase",
        )
        // A revert's write ends the revert: the claim `work revert` took is released.
        const released = ctx.payload.revertOf ? (yield* call(() => s.session.release(s.scope, s.who, [key]))).released : []
        return { entry: result.entry, version: result.version, changed: result.changed, summary: ContentFields.describe(ctx.payload.content, result.changed.length), released }
      }),
    )
    .handle("revert", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        const key = yield* normalize(ctx.payload.url, s.info.rules)
        const plan = yield* call(() => s.session.revert(s.scope, s.who, key, ctx.payload.version, ctx.payload.fields), "KeyHeld", "RevertConflict")
        const currentContent = plan.content ? yield* getBlob(s.caller.org, ctx.params.workspace, plan.content) : null
        return { ...plan, content: ContentFields.apply(currentContent, plan.values) }
      }),
    )
    .handle("requestRevert", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        if (w.caller.role === "viewer") return yield* new Errors.Invalid({ message: "Viewers cannot request a revert" })
        const key = yield* normalize(ctx.payload.url, w.info.rules)
        const caller = { actor: { ...w.caller.actor, agent: null }, session: null, member: null, trajectory: null, intent: null, now: Date.now() }
        return yield* call(() => w.object.requestRevert(caller, key, ctx.payload.version, ctx.payload.to ?? w.caller.actor.handle))
      }),
    )
    .handle("history", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const key = yield* normalize(ctx.query.url, w.info.rules)
        return yield* call(() => w.object.history(key))
      }),
    )
    .handle("version", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const key = yield* normalize(ctx.query.url, w.info.rules)
        const version = yield* call(() => w.object.version(key, ctx.query.version))
        return { version, content: yield* getBlob(w.caller.org, ctx.params.workspace, version.content) }
      }),
    ),
)

const MessageHandlers = HttpApiBuilder.group(Api, "message", (handlers) =>
  handlers
    .handle("send", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const p = ctx.payload
        const looksLikeUrl = (s: string) => /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)|^https?:\/\//i.test(s)
        const key = p.url ? yield* normalize(p.url, w.info.rules) : p.to && looksLikeUrl(p.to) ? yield* normalize(p.to, w.info.rules) : null
        const to = p.to && looksLikeUrl(p.to) ? key : (p.to ?? null)
        // A person in the browser comments straight into the workspace log.
        if (!w.caller.session || !w.caller.actor.agent) {
          if (p.kind !== "comment") return yield* new Errors.Invalid({ message: "Only agents ask, tell and hand off" })
          const caller = { actor: w.caller.actor, session: null, member: null, trajectory: null, intent: null, now: Date.now() }
          const entry = yield* call(() => w.object.comment(caller, { key, ref: p.ref ?? null, text: p.text, version: p.version ?? null }))
          return entry
        }
        const s = yield* sessionFor(ctx.params.workspace)
        return yield* call(() =>
          s.session.record(s.scope, s.who, { kind: p.kind, text: p.text, to, keys: key ? [key] : [], ref: p.ref ?? null, version: p.version ?? null }),
        )
      }),
    )
    .handle("addTask", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        return yield* call(() => s.session.record(s.scope, s.who, { kind: "task.add", text: ctx.payload.title }))
      }),
    )
    .handle("takeTask", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        return (yield* call(() => s.session.takeTask(s.scope, s.who, ctx.payload.task), "TaskTaken")).task
      }),
    )
    .handle("doneTask", (ctx) =>
      Effect.gen(function* () {
        const s = yield* sessionFor(ctx.params.workspace)
        return yield* call(() => s.session.record(s.scope, s.who, { kind: "task.done", text: ctx.payload.task }))
      }),
    )
    .handle("tasks", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        return yield* call(() => w.object.tasks())
      }),
    ),
)

const LogHandlers = HttpApiBuilder.group(Api, "log", (handlers) =>
  handlers
    .handle("log", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const key = ctx.query.url ? yield* normalize(ctx.query.url, w.info.rules) : undefined
        return yield* call(() =>
          w.object.log({
            key,
            sinceVersion: ctx.query.sinceVersion,
            sinceSeq: ctx.query.sinceSeq,
            by: ctx.query.by,
            session: ctx.query.session,
            trajectory: ctx.query.trajectory,
            limit: ctx.query.limit,
          }),
        )
      }),
    )
    .handle("entry", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        return yield* call(() => w.object.entry(ctx.params.seq))
      }),
    )
    .handle("inbox", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const session = w.caller.ownSession ?? w.caller.session
        if (!session) return yield* new Errors.Invalid({ message: "No agent session: run `work init`, or pass --session" })
        // Flush first, so this session's own answers are in the log before it reads.
        yield* call(() => sessionObject({ org: w.caller.org, workspace: ctx.params.workspace, session }).flush({ org: w.caller.org, workspace: ctx.params.workspace, session }))
        return yield* call(() => w.object.inbox({ session, address: Actor.address(w.caller.actor), handle: w.caller.actor.handle }, ctx.query.peek === undefined))
      }),
    )
    .handle("today", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const since = ctx.query.since ?? new Date(new Date().toISOString().slice(0, 10)).getTime()
        return yield* call(() => w.object.today(since))
      }),
    )
    .handle("blob", (ctx) =>
      Effect.gen(function* () {
        const w = yield* workspaceFor(ctx.params.workspace)
        const content = yield* getBlob(w.caller.org, ctx.params.workspace, ctx.params.hash)
        if (content === null) return yield* new Errors.NotFound({ what: "content", id: ctx.params.hash })
        return { content }
      }),
    ),
)

/** Checks the caller once per request and provides it to every handler. */
const AuthorizationLive = Layer.succeed(
  Authorization,
  Authorization.of((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = request.source as Request
      const result = yield* Effect.promise(() => Auth.identify(env, raw))
      if (!result.ok) return yield* (result.status === 401 ? new Errors.Unauthorized({ message: result.message }) : new Errors.Forbidden({ message: result.message }))
      const agent = raw.headers.get(Caller.headers.agent)
      const session = raw.headers.get(Caller.headers.session)
      const caller: Caller.Info = {
        actor: Auth.actor(result.person, agent),
        email: result.person.email,
        org: result.person.org,
        role: result.person.role,
        session: session && /^[A-Za-z0-9._:-]{1,128}$/.test(session) ? session : null,
        ownSession: raw.headers.get(Caller.headers.ownSession),
      }
      return yield* Effect.provideService(effect, Caller.Current, caller)
    }),
  ),
)

export const handlers = Layer.mergeAll(AccountHandlers, SessionHandlers, ClaimHandlers, WriteHandlers, MessageHandlers, LogHandlers).pipe(Layer.provide(AuthorizationLive))
export { AuthorizationLive }
