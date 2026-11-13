import { DurableObject } from "cloudflare:workers"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "@work/core/database/database"
import { sqliteLayer, type DurableObjectStorage as SqliteStorage } from "@work/core/database/sqlite.workerd"
import { Session } from "@work/core/session/session"
import type { Workspace } from "@work/core/workspace/workspace"
import { Actor } from "@work/schema/actor"
import type { Entry } from "@work/schema/entry"
import type { Session as SessionSchema } from "@work/schema/session"
import { type Env, names, stub } from "../env.ts"
import { Rpc } from "../rpc.ts"

/** Where this object sits. Passed with every call; the object is named after it. */
export interface Scope {
  readonly org: string
  readonly workspace: string
  readonly session: string
}

const FLUSH_DELAY = 2_000

type Services = Database.Service | Session.Link | Session.Lock

/**
 * One per agent session. Holds the session's own log, flushes it to the workspace, and runs coordinated actions
 * through it. Other agents and people join it over hibernating WebSockets; each socket's attachment is a presence
 * record.
 */
export class SessionObject extends DurableObject<Env> {
  private runtime: ManagedRuntime.ManagedRuntime<Services, never> | null = null
  private scope: Scope | null = null

  private workspace(scope: Scope) {
    return stub(this.env.WORKSPACE, names.workspace(scope.org, scope.workspace))
  }

  private starting: Promise<ManagedRuntime.ManagedRuntime<Services, never>> | null = null

  /**
   * The runtime, after repair and a flush. Every call waits for the same start, so none records an event before the
   * workspace's decisions this object missed are back: a new event would otherwise take an aseq the workspace holds.
   */
  private ready(scope: Scope) {
    this.starting ??= this.boot(scope).catch((error) => {
      this.starting = null
      throw error
    })
    return this.starting
  }

  private async boot(scope: Scope) {
    this.scope = scope
    await this.ctx.storage.put("scope", scope)
    const workspace = this.workspace(scope)
    const link = Layer.succeed(
      Session.Link,
      Session.Link.of({
        replay: (events) =>
          Rpc.unwrap(() => workspace.replay(scope.session, Rpc.plain(events))).pipe(
            Effect.catch((error) => (error._tag === "Gap" || error._tag === "Invalid" ? Effect.fail(error) : Effect.die(error))),
          ),
        since: (aseq) => Effect.promise(() => workspace.sessionEvents(scope.session, aseq)),
      }),
    )
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(Database.layer("session").pipe(Layer.provide(sqliteLayer({ storage: this.ctx.storage as unknown as SqliteStorage }))), Session.lockLayer, link),
    )
    // Take back anything the workspace decided that this object never recorded, then flush what is pending.
    await runtime.runPromise(Session.repair)
    this.runtime = runtime
    await runtime.runPromiseExit(Session.flush)
    return runtime
  }

  private async run<A, E>(scope: Scope, effect: Effect.Effect<A, E, Services>) {
    const runtime = await this.ready(scope)
    const result = await Rpc.run(runtime.runPromiseExit(effect))
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY)
    return result
  }

  /** Flushes what is pending. After eviction the object starts again from the scope it stored. */
  async alarm() {
    const scope = this.scope ?? ((await this.ctx.storage.get("scope")) as Scope | undefined)
    if (!scope) return
    const runtime = await this.ready(scope)
    const flushed = await runtime.runPromiseExit(Session.flush)
    const pending = await runtime.runPromise(Effect.map(Session.events(await runtime.runPromise(Session.flushed)), (e) => e.length))
    if (flushed._tag === "Failure" || pending > 0) await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY * 5)
  }

  /** The caller as the workspace wants it: who, from which session and trajectory. */
  private caller(who: Session.Who) {
    return Effect.gen(function* () {
      const trajectory = yield* Session.current(who.member)
      const events = trajectory ? yield* Session.events(0, trajectory) : []
      return {
        actor: who.actor,
        session: who.session,
        member: who.member,
        trajectory,
        intent: events.find((e) => e.kind === "trajectory.start")?.text ?? null,
        now: who.now,
      } satisfies Workspace.Caller
    })
  }

  private coordinate<A>(who: Session.Who, kind: Entry.Kind, keys: ReadonlyArray<string>, call: (caller: Workspace.Caller) => Promise<Rpc.Result<A>>) {
    const self = this
    return Effect.gen(function* () {
      const caller = yield* self.caller(who)
      return yield* Session.coordinate(who, kind, keys, Rpc.unwrap(() => call(Rpc.plain(caller))))
    })
  }

  // The session's own events

  async claimOwner(scope: Scope, actor: Actor.Info) {
    return this.run(scope, Session.claimOwner(actor))
  }

  start(scope: Scope, who: Session.Who, input: { id: string; intent: string; forHandle: string; forName: string }) {
    return this.run(
      scope,
      Effect.gen(function* () {
        yield* Session.claimOwner(who.actor)
        return yield* Session.start(who, input)
      }),
    )
  }

  record(scope: Scope, who: Session.Who, draft: Parameters<typeof Session.record>[1]) {
    return this.run(
      scope,
      Effect.gen(function* () {
        yield* Session.claimOwner(who.actor)
        return yield* Session.record(who, draft)
      }),
    )
  }

  end(scope: Scope, who: Session.Who, status: "done" | "failed", why: string | null) {
    const workspace = this.workspace(scope)
    const self = this
    return this.run(
      scope,
      Effect.gen(function* () {
        const event = yield* Session.end(who, status, why)
        const released = yield* self.coordinate(who, "release", [], (caller) => workspace.release(caller, []))
        return { event, released: released.released }
      }),
    )
  }

  flush(scope: Scope) {
    return this.run(scope, Effect.map(Session.flush, (flushed) => ({ flushed })))
  }

  /** The version of `key` this session last read, for a write that does not name its base. */
  lastRead(scope: Scope, key: string) {
    return this.run(
      scope,
      Effect.map(Session.events(), (events) => events.filter((e) => e.kind === "read" && e.keys.includes(key as never)).at(-1)?.version ?? undefined),
    )
  }

  // Coordinated actions

  claim(scope: Scope, who: Session.Who, keys: ReadonlyArray<{ key: string; title: string | null }>, wait: number) {
    const workspace = this.workspace(scope)
    return this.run(scope, this.coordinate(who, "claim", keys.map((k) => k.key), (caller) => workspace.claim(caller, keys, wait)))
  }
  release(scope: Scope, who: Session.Who, keys: ReadonlyArray<string>) {
    const workspace = this.workspace(scope)
    return this.run(scope, this.coordinate(who, "release", keys, (caller) => workspace.release(caller, keys)))
  }
  write(scope: Scope, who: Session.Who, input: Workspace.WriteInput) {
    const workspace = this.workspace(scope)
    return this.run(scope, this.coordinate(who, "write", [input.key], (caller) => workspace.write(caller, input)))
  }
  revert(scope: Scope, who: Session.Who, key: string, version: number, fields: ReadonlyArray<string> | undefined) {
    const workspace = this.workspace(scope)
    return this.run(scope, this.coordinate(who, "revert.start", [key], (caller) => workspace.revert(caller, key, version, fields)))
  }
  takeTask(scope: Scope, who: Session.Who, task: string) {
    const workspace = this.workspace(scope)
    return this.run(scope, this.coordinate(who, "task.take", [], (caller) => workspace.takeTask(caller, task)))
  }

  // Reads

  view(scope: Scope) {
    const members = this.members()
    return this.run(
      scope,
      Effect.gen(function* () {
        return {
          session: scope.session,
          owner: yield* Session.owner,
          trajectories: yield* Session.trajectories,
          events: yield* Session.events(),
          members,
          flushed: yield* Session.flushed,
        }
      }),
    )
  }

  // Presence

  private members(exclude?: WebSocket): SessionSchema.Member[] {
    const seen = new Map<string, SessionSchema.Member>()
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue
      const member = ws.deserializeAttachment() as SessionSchema.Member | null
      if (member && !seen.has(member.address)) seen.set(member.address, member)
    }
    return [...seen.values()].sort((a, b) => a.since - b.since)
  }

  private async presenceChanged(scope: Scope, member: SessionSchema.Member, kind: "join" | "leave", closing?: WebSocket) {
    const members = this.members(closing)
    const message = JSON.stringify({ type: kind, member, members })
    for (const ws of this.ctx.getWebSockets()) if (ws !== closing) ws.send(message)
    const runtime = await this.ready(scope)
    const owner = await runtime.runPromise(Session.owner)
    const who: Session.Who = {
      session: scope.session,
      actor: { person: member.person as Actor.Info["person"], handle: member.address.split("/")[0], name: member.label, agent: member.kind === "agent" ? member.address.split("/")[1] ?? null : null },
      member: member.address,
      now: Date.now(),
    }
    // Agents joining and leaving is part of the session's story; people watching in the browser only show as present.
    if (member.kind === "agent") await runtime.runPromiseExit(Session.record(who, { kind, text: member.label, trajectory: null }))
    await this.workspace(scope).setPresence(scope.session, owner ?? who.actor, members)
    // Joins and leaves go to the workspace now, so Today and watchers see them without waiting for the alarm.
    const flushed = await runtime.runPromiseExit(Session.flush)
    if (flushed._tag === "Failure" && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY)
  }

  /** A presence socket. The Worker has checked the caller and passes the member and scope in headers. */
  async fetch(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 })
    const scope = JSON.parse(request.headers.get("x-work-scope")!) as Scope
    const caller = JSON.parse(request.headers.get("x-work-member")!) as { actor: Actor.Info; kind: "agent" | "person" }
    const runtime = await this.ready(scope)
    const owner = await runtime.runPromise(Session.claimOwner(caller.actor))
    const address = Actor.address(caller.actor)
    const member: SessionSchema.Member = {
      id: crypto.randomUUID(),
      kind: caller.kind,
      address,
      label: Actor.label(caller.actor),
      person: caller.actor.person,
      since: Date.now(),
      owner: Actor.address(owner) === address,
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment(member)
    const first = !this.members().some((m) => m.address === address && m.id !== member.id)
    pair[1].send(JSON.stringify({ type: "hello", member, members: this.members() }))
    if (first) await this.presenceChanged(scope, member, "join")
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong")
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const member = ws.deserializeAttachment() as SessionSchema.Member | null
    ws.close(code === 1005 ? 1000 : code)
    const scope = this.scope ?? ((await this.ctx.storage.get("scope")) as Scope | undefined)
    if (!member || !scope) return
    const still = this.ctx.getWebSockets().some((s) => s !== ws && (s.deserializeAttachment() as SessionSchema.Member | null)?.address === member.address)
    if (!still) await this.presenceChanged(scope, member, "leave", ws)
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011)
  }
}
