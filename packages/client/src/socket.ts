export * as WorkSocket from "./socket.ts"

import { Caller, sockets } from "@work/protocol"
import type { Entry } from "@work/schema/entry"
import type { Session } from "@work/schema/session"
import type { Options } from "./client.ts"

export type WatchMessage = { type: "entries"; entries: Entry.Info[] } | { type: "synced"; seq: number }
export type PresenceMessage =
  | { type: "hello"; member: Session.Member; members: Session.Member[] }
  | { type: "join" | "leave"; member: Session.Member; members: Session.Member[] }

const wsUrl = (baseUrl: string, path: string, query: Record<string, string> = {}) => {
  const url = new URL(path, baseUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return url.toString()
}

/** Bun's WebSocket takes headers; the browser sends its cookie and passes the agent, if any, in the query. */
const open = async (options: Options, url: string) => {
  const token = options.token ? await options.token() : null
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (options.agent) headers[Caller.headers.agent] = options.agent
  return typeof Bun !== "undefined" ? new WebSocket(url, { headers } as never) : new WebSocket(url)
}

export interface Handle {
  readonly close: () => void
}

/**
 * Follows the workspace log from `after`: replays what was missed, calls `onSynced` once caught up, then delivers new
 * entries. Reconnects from the last seq it saw, so nothing is skipped or seen twice.
 */
export const watch = (
  options: Options,
  workspace: string,
  after: number,
  on: { entries: (entries: Entry.Info[]) => void; synced?: (seq: number) => void; error?: (error: unknown) => void },
): Handle => {
  let seq = after
  let closed = false
  let socket: WebSocket | null = null
  let retry = 500
  const connect = async () => {
    if (closed) return
    const path = sockets.watch(workspace, seq)
    const ws = await open(options, wsUrl(options.baseUrl, path.split("?")[0]!, { after: String(seq) }))
    socket = ws
    ws.onmessage = (m) => {
      const message = JSON.parse(String(m.data)) as WatchMessage
      if (message.type === "entries") {
        const fresh = message.entries.filter((e) => e.seq > seq)
        if (fresh.length === 0) return
        seq = fresh.at(-1)!.seq
        on.entries(fresh)
      } else {
        retry = 500
        on.synced?.(message.seq)
      }
    }
    ws.onerror = (e) => on.error?.(e)
    ws.onclose = () => {
      if (closed) return
      setTimeout(connect, retry)
      retry = Math.min(retry * 2, 15_000)
    }
  }
  void connect()
  return {
    close: () => {
      closed = true
      socket?.close()
    },
  }
}

/** Joins a session: the socket stays open while this member is present. */
export const presence = (
  options: Options,
  workspace: string,
  session: string,
  on: { message: (message: PresenceMessage) => void; closed?: () => void },
): Handle => {
  let closed = false
  let socket: WebSocket | null = null
  let retry = 500
  const connect = async () => {
    if (closed) return
    const ws = await open(options, wsUrl(options.baseUrl, sockets.presence(workspace, session), options.agent ? { agent: options.agent } : {}))
    socket = ws
    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000)
    ws.onmessage = (m) => {
      if (m.data === "pong") return
      retry = 500
      on.message(JSON.parse(String(m.data)) as PresenceMessage)
    }
    ws.onclose = () => {
      clearInterval(ping)
      if (closed) return on.closed?.()
      setTimeout(connect, retry)
      retry = Math.min(retry * 2, 15_000)
    }
  }
  void connect()
  return {
    close: () => {
      closed = true
      socket?.close()
    },
  }
}
