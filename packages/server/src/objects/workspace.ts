import { DurableObject } from "cloudflare:workers"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "@work/core/database/database"
import { sqliteLayer, type DurableObjectStorage as SqliteStorage } from "@work/core/database/sqlite.workerd"
import { Workspace } from "@work/core/workspace/workspace"
import type { Actor } from "@work/schema/actor"
import type { Entry } from "@work/schema/entry"
import type { Session } from "@work/schema/session"
import type { Env } from "../env.ts"
import { Rpc } from "../rpc.ts"

type Caller = Workspace.Caller

const SYSTEM: Actor.Info = { person: "system" as Actor.Info["person"], handle: "work", name: "Work", agent: null }

/**
 * One per workspace: the only sequencer. Claims, writes, reverts, comments, tasks and every session's flushed events
 * are decided and ordered here. Watchers follow its log over hibernating WebSockets.
 */
export class WorkspaceObject extends DurableObject<Env> {
  private readonly runtime: ManagedRuntime.ManagedRuntime<Database.Service, never>
  /** The highest seq sent to watchers. */
  private sent = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.runtime = ManagedRuntime.make(Database.layer("workspace").pipe(Layer.provide(sqliteLayer({ storage: ctx.storage as unknown as SqliteStorage }))))
    ctx.blockConcurrencyWhile(async () => {
      const head = await this.runtime.runPromise(Workspace.log({ limit: 1 }))
      this.sent = head[0]?.seq ?? 0
    })
  }

  private read<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
    return Rpc.run(this.runtime.runPromiseExit(effect))
  }

  /** Runs a change, then tells watchers and re-arms the alarm. */
  private async change<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
    const result = await this.read(effect)
    await this.afterChange()
    return result
  }

  private async afterChange() {
    const fresh = await this.runtime.runPromise(Workspace.log({ sinceSeq: this.sent, order: "asc", limit: 1000 }))
    if (fresh.length > 0) {
      this.sent = fresh.at(-1)!.seq
      const message = JSON.stringify({ type: "entries", entries: fresh })
      for (const ws of this.ctx.getWebSockets()) ws.send(message)
    }
    const next = await this.runtime.runPromise(Workspace.nextAlarm)
    if (next !== null && ((await this.ctx.storage.getAlarm()) ?? Infinity) > next) await this.ctx.storage.setAlarm(next)
  }

  async alarm() {
    const result = await this.runtime.runPromise(Workspace.expire(Date.now(), SYSTEM))
    await this.afterChange()
    if (result.next !== null) await this.ctx.storage.setAlarm(result.next)
  }

  // Sessions

  replay(session: string, events: ReadonlyArray<Entry.Event>) {
    return this.change(Workspace.replay(session, events, Date.now()))
  }
  sessionEvents(session: string, after: number) {
    return this.runtime.runPromise(Workspace.sessionEvents(session, after)).then(Rpc.plain)
  }
  setPresence(session: string, owner: Actor.Info, members: ReadonlyArray<Session.Member>) {
    return this.change(Workspace.setPresence(session, owner, members, Date.now()))
  }

  // Coordinated actions

  claim(caller: Caller, keys: ReadonlyArray<{ key: string; title: string | null }>, wait: number) {
    return this.change(Workspace.claim(caller, keys, wait))
  }
  release(caller: Caller, keys: ReadonlyArray<string>) {
    return this.change(Workspace.release(caller, keys))
  }
  waiter(id: number) {
    return this.read(
      Effect.gen(function* () {
        const status = yield* Workspace.waiterStatus(id)
        const entry = status.seq === null ? null : yield* Workspace.entry(status.seq)
        return { ...status, entry }
      }),
    )
  }
  cancelWait(session: string, id: number) {
    return this.change(Workspace.cancelWait(session, id))
  }
  write(caller: Caller, input: Workspace.WriteInput) {
    return this.change(Workspace.write(caller, input))
  }
  revert(caller: Caller, key: string, version: number, fields: ReadonlyArray<string> | undefined) {
    return this.change(Workspace.revert(caller, key, version, fields))
  }
  requestRevert(caller: Caller, key: string, version: number, to: string) {
    return this.change(Workspace.requestRevert(caller, key, version, to))
  }
  comment(caller: Caller, input: { key: string | null; ref: number | null; text: string; version: number | null; to: string | null }) {
    return this.change(Workspace.comment(caller, input))
  }
  takeTask(caller: Caller, task: string) {
    return this.change(Workspace.takeTask(caller, task))
  }

  // Reads

  tasks() {
    return this.read(Workspace.tasks())
  }
  who(key: string) {
    return this.read(Workspace.who(key))
  }
  log(filter: Workspace.LogFilter) {
    return this.read(Workspace.log(filter))
  }
  entry(seq: number) {
    return this.read(Workspace.entry(seq))
  }
  history(key: string) {
    return this.read(Workspace.history(key))
  }
  version(key: string, v: number) {
    return this.read(Workspace.version(key, v))
  }
  inbox(me: { session: string; address: string; handle: string }, advance: boolean) {
    return this.read(Workspace.inbox(me, advance))
  }
  today(since: number) {
    return this.read(Workspace.today(since))
  }

  // Watch: replay after the cursor, a `synced` marker, then live entries.

  async fetch(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 })
    const after = Number(new URL(request.url).searchParams.get("after") ?? "0") || 0
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    const backlog = await this.runtime.runPromise(Workspace.log({ sinceSeq: after, order: "asc", limit: 5000 }))
    for (let i = 0; i < backlog.length; i += 200) pair[1].send(JSON.stringify({ type: "entries", entries: backlog.slice(i, i + 200) }))
    pair[1].send(JSON.stringify({ type: "synced", seq: backlog.at(-1)?.seq ?? after }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong")
  }

  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code === 1005 ? 1000 : code)
  }
}
