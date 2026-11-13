export * as Init from "./init.ts"

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import type { Entry } from "@work/schema/entry"
import { Config } from "./config.ts"
import { Context, type Flags } from "./context.ts"
import { Identity } from "./identity.ts"
import { Exit, EXIT, address, print } from "./output.ts"
import { Presence } from "./presence.ts"
import type { Opts } from "./commands.ts"

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined)

const gitRoot = (dir: string) => {
  const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stdout: "pipe", stderr: "ignore" })
  return r.exitCode === 0 ? r.stdout.toString().trim() : null
}

const quote = (s: string) => (/^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** How hooks should run `work`: as `work` when that is this CLI on the PATH, else by its full path. */
const commandLine = (opts: Opts) => {
  const given = str(opts.command)
  if (given) return given
  const self = Presence.self()
  const onPath = Bun.which("work")
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  // `work` on the PATH is this CLI (the binary, or a link to the script): hooks call it by name.
  if (onPath && real(onPath) === real(self.at(-1)!)) return "work"
  return self.map(quote).join(" ")
}

const MARK_START = "<!-- work:start -->"
const MARK_END = "<!-- work:end -->"

/** One section for every agent: Claude and Codex read the same instructions, whichever file holds them. */
const instructions = `${MARK_START}
## Work log

This project logs agent work with the \`work\` CLI, so people and other agents see what was done, by whom and why, and nobody overwrites anyone.

- Start each task with \`work start "<what you are doing, for whom>"\`; end it with \`work done\` or \`work fail "<why>"\`. Both release your claims.
- Before you change something others may change too (a file, a doc, a sheet, a record), claim it: \`work claim <url or path>\`. If it is held, ask the holder with \`work ask <url> "<question>"\`, or wait with \`work claim <url> --wait 10m\`.
- Say what you read with \`work read <url>\` and write with \`work put <url> --from <file>\` (a path in this checkout needs no --from). A refusal names who wrote since you read: read again, redo the change on top, then put. \`work read <path> --out <path>\` brings a checkout file up to date with Work.
- Check \`work inbox\` when you start and between steps (with Claude Code's hooks, new items appear in your context by themselves). Answer with \`work tell <who> "<text>"\`; \`work note "<text>"\` records a decision in your own words.
- Waiting on another agent? Run \`work wait --for 30m\` in the background: it ends when something reaches your inbox, so the answer wakes you instead of waiting for the person to prompt you.
- A revert request names its command: \`work revert <url>@vN --put\` puts the old values back and writes the next version.
- \`work help\` lists everything. Exit 1 is a refusal to act on, 2 a mistake in the command, 3 means sign in with \`work login\`.
${MARK_END}
`

/** Puts the instructions block in a Markdown file, replacing an earlier one. */
function writeBlock(file: string, block: string) {
  const before = existsSync(file) ? readFileSync(file, "utf8") : ""
  const start = before.indexOf(MARK_START)
  const end = before.indexOf(MARK_END)
  const next =
    start >= 0 && end > start
      ? before.slice(0, start) + block.trimEnd() + before.slice(end + MARK_END.length)
      : `${before}${before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : ""}${block}`
  if (next !== before) writeFileSync(file, next)
  return next !== before
}

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }

/** Adds the hooks to a Claude settings file, replacing earlier `work hook claude` entries and keeping everything else. */
function mergeClaudeSettings(file: string, command: string) {
  const settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, HookEntry[]> }) : {}
  const ours = (event: string, timeout: number, matcher?: string): HookEntry => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: `${command} hook claude ${event}`, timeout }],
  })
  const wanted: Record<string, HookEntry> = {
    SessionStart: ours("session-start", 15),
    UserPromptSubmit: ours("prompt", 10),
    PostToolUse: ours("tool", 10, "*"),
    SessionEnd: ours("session-end", 10),
  }
  const hooks = { ...(settings.hooks ?? {}) }
  for (const [event, entry] of Object.entries(wanted)) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !/ hook claude [a-z-]+$/.test(h.command)) }))
      .filter((e) => e.hooks.length > 0)
    hooks[event] = [...kept, entry]
  }
  const next = JSON.stringify({ ...settings, hooks }, null, 2) + "\n"
  const before = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (next === before) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, next)
  return true
}

/** Adds `notify` to Codex's config when it has none; Codex allows one notify program. */
function addCodexNotify(file: string, command: string) {
  const before = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (/^\s*notify\s*=/m.test(before)) return before.includes("hook\", \"codex\"") || before.includes(" hook codex") ? "present" : "taken"
  const argv = [...command.split(" ").map((p) => p.replace(/^'|'$/g, "")), "hook", "codex", "notify"]
  // Top-level keys have to come before the first table.
  const line = `notify = [${argv.map((a) => JSON.stringify(a)).join(", ")}]\n`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, before ? `${line}${before.startsWith("\n") ? "" : "\n"}${before}` : line)
  return "added"
}

export async function init(_flags: Flags, [agent]: string[], opts: Opts) {
  const dir = gitRoot(process.cwd()) ?? process.cwd()
  const command = commandLine(opts)
  const done: string[] = []
  if (agent === "claude") {
    const scope = str(opts.scope) ?? "project"
    const file =
      scope === "user"
        ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json")
        : join(dir, ".claude", scope === "local" ? "settings.local.json" : "settings.json")
    if (!["project", "local", "user"].includes(scope)) throw new Exit(EXIT.usage, "--scope is project, local or user")
    done.push(`${mergeClaudeSettings(file, command) ? "Added hooks to" : "Hooks already in"} ${relative(process.cwd(), file) || file}`)
    // Claude Code reads AGENTS.md when there is no CLAUDE.md; one file of instructions is enough.
    const md = join(dir, !existsSync(join(dir, "CLAUDE.md")) && existsSync(join(dir, "AGENTS.md")) ? "AGENTS.md" : "CLAUDE.md")
    done.push(`${writeBlock(md, instructions) ? "Wrote the Work section in" : "Work section already in"} ${relative(process.cwd(), md) || md}`)
  } else if (agent === "codex") {
    const md = join(dir, "AGENTS.md")
    done.push(`${writeBlock(md, instructions) ? "Wrote the Work section in" : "Work section already in"} ${relative(process.cwd(), md) || md}`)
    const config = join(str(opts["codex-home"]) ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml")
    const result = addCodexNotify(config, command)
    done.push(
      result === "added"
        ? `Added notify to ${config}`
        : result === "present"
          ? `notify already set in ${config}`
          : `${config} already has a notify program; Codex allows one, so it was left alone`,
    )
  } else throw new Exit(EXIT.usage, "Usage: work init claude|codex [--scope project|local|user] [--command <how to run work>]")
  const workspace = Config.workspaceFor(dir)
  if (!workspace) done.push("Choose this directory's workspace with: work use <workspace>")
  print(done.join(".\n") + ".", { agent, dir, command, workspace })
}

// Hooks. They never fail the agent: any trouble is swallowed and the agent carries on.

interface ClaudeInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  source?: string
}

const short = (s: string, n: number) => {
  const one = s.split("\n")[0]!.trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** What a tool call did, in a line, without any file contents or tool output. */
export function summarize(tool: string, input: Record<string, unknown>, cwd: string) {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  const path = (p: string) => (p ? (p.startsWith(cwd + "/") ? relative(cwd, p) : p) : "")
  switch (tool) {
    case "Bash":
      return short(s("command"), 160)
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path(s("file_path") || s("notebook_path"))
    case "Grep":
    case "Glob":
      return `${short(s("pattern"), 80)}${s("path") ? ` in ${path(s("path"))}` : ""}`
    case "WebFetch":
      return short(s("url"), 160)
    case "WebSearch":
      return short(s("query"), 120)
    case "Task":
    case "Agent":
      return short(s("description"), 120)
    default:
      return ""
  }
}

/** Calls to `work` itself already log what they did. */
const isWorkCall = (tool: string, input: Record<string, unknown>) => tool === "Bash" && typeof input.command === "string" && /^\s*(\S*\/)?work(\s|$)/.test(input.command)

const inboxText = (items: readonly Entry.Info[]) =>
  [
    "Work inbox:",
    ...items.map((e) => {
      const from = e.actor.agent ? address(e.actor) : `${e.actor.name} (${e.actor.handle})`
      const on = e.keys[0] ? ` on ${e.keys[0]}${e.version ? ` v${e.version}` : ""}` : ""
      if (e.kind === "revert.request") return `- ${from} asks you to revert v${e.version} of ${e.keys[0]}: run \`work revert ${e.keys[0]}@v${e.version}\`.`
      if (e.kind === "handoff") return `- ${from} hands you "${e.text}": take it with \`work task take "${e.text}"\`.`
      return `- ${from} ${e.kind === "comment" ? "commented" : e.kind === "ask" ? "asks" : "says"}${on}: ${e.text}`
    }),
    "Answer with `work tell <who> \"<text>\"`.",
  ].join("\n")

const emit = (event: string, context: string | null) => {
  if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) + "\n")
}

const INBOX_EVERY = 60_000

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The session this conversation works in, and whether its inbox is this conversation's to read. A conversation that
 * took over another's session (by running `work` as it) works there; a session driven more recently by another live
 * conversation keeps its inbox for that one.
 */
function driving(own: string) {
  const me = process.env.WORK_DETECT === "0" ? null : (Identity.detect()?.pid ?? null)
  const all = Config.drivers()
  const session = (me && all[me]?.session) || own
  const latest = Object.entries(all)
    .filter(([pid, d]) => d.session === session && alive(Number(pid)))
    .sort((a, b) => b[1].at - a[1].at)[0]
  return { session, readsInbox: !latest || !me || Number(latest[0]) === me }
}

async function claudeHook(event: string, input: ClaudeInput) {
  if (!input.session_id) return
  const own = `claude-${input.session_id}`
  const { session, readsInbox } = driving(own)
  if (input.cwd) process.chdir(input.cwd)
  if (event === "session-start" && process.env.CLAUDE_ENV_FILE) {
    const lines = `export WORK_AGENT=claude\nexport WORK_SESSION=${session}\n`
    const existing = existsSync(process.env.CLAUDE_ENV_FILE) ? readFileSync(process.env.CLAUDE_ENV_FILE, "utf8") : ""
    if (!existing.includes(lines)) writeFileSync(process.env.CLAUDE_ENV_FILE, existing + lines)
  }
  if (event === "session-end") {
    Presence.leave(own)
    Presence.absent(own)
  }
  let ctx: Awaited<ReturnType<typeof Context.make>>
  try {
    ctx = await Context.make({ agent: "claude", session })
  } catch {
    if (event === "session-start") emit("SessionStart", "Work: not signed in, so this session is not logged. Ask the person to run `work login`.")
    return
  }
  try {
    const workspace = await ctx.workspace().catch(() => null)
    if (!workspace) return
    const params = { workspace }
    if (event !== "session-end") Presence.attend(ctx, workspace)
    if (event === "tool" && input.tool_name && !isWorkCall(input.tool_name, input.tool_input ?? {})) {
      const summary = summarize(input.tool_name, input.tool_input ?? {}, input.cwd ?? process.cwd())
      await ctx.call((c) => c.session.step({ params, payload: { kind: "tool", text: summary ? `${input.tool_name}: ${summary}` : input.tool_name!, data: { tool: input.tool_name } } }))
    }
    if (event === "session-end") {
      await ctx.call((c) => c.session.flush({ params }))
      return
    }
    // The inbox: every prompt and session start, and at most once a minute between tool calls. Only the conversation
    // that drives the session reads it, so a message never lands in a conversation that has moved on.
    const name = event === "session-start" ? "SessionStart" : event === "prompt" ? "UserPromptSubmit" : "PostToolUse"
    const intro = event === "session-start" ? `Work: this session is ${session} in workspace ${workspace}.${ctx.who.ownSession ? ` It has joined ${ctx.who.session}.` : ""}` : null
    const mine = ctx.who.ownSession ?? session
    const state = Config.state(mine)
    if (!readsInbox || (event === "tool" && Date.now() - (state.inboxCheckedAt ?? 0) < INBOX_EVERY)) return emit(name, intro)
    Config.saveState(mine, { ...Config.state(mine), inboxCheckedAt: Date.now() })
    const inbox = await ctx.call<{ items: Entry.Info[] }>((c) => c.log.inbox({ params, query: {} }))
    emit(name, [intro, inbox.items.length ? inboxText(inbox.items) : null].filter(Boolean).join("\n\n") || null)
  } finally {
    ctx.dispose()
  }
}

async function codexHook(event: string, args: string[]) {
  if (event !== "notify") return
  const payload = JSON.parse(args.at(-1) ?? "{}") as { type?: string; cwd?: string; "turn-id"?: string }
  if (payload.type !== "agent-turn-complete") return
  if (payload.cwd) process.chdir(payload.cwd)
  const who = Identity.resolve({})
  if (!who.agent || !who.session) return
  const ctx = await Context.make({})
  try {
    const workspace = await ctx.workspace().catch(() => null)
    if (!workspace) return
    // Marks the session active, so its claims stay held while Codex works; nothing of the turn's content is sent.
    await ctx.call((c) => c.session.step({ params: { workspace }, payload: { kind: "tool", text: "turn", data: { tool: "turn", turn: payload["turn-id"] ?? null } } }))
  } finally {
    ctx.dispose()
  }
}

/** `work hook claude <event>` (input on stdin) and `work hook codex notify <json>`. */
export async function hook(agent: string | undefined, event: string | undefined, rest: string[]) {
  try {
    if (agent === "claude" && event) {
      const raw = await Bun.stdin.text()
      await claudeHook(event, raw.trim() ? (JSON.parse(raw) as ClaudeInput) : {})
    } else if (agent === "codex" && event) await codexHook(event, rest)
  } catch (error) {
    // Never break the agent; leave a trace for whoever looks.
    try {
      const log = join(Config.home(), "hook-errors.log")
      mkdirSync(dirname(log), { recursive: true })
      writeFileSync(log, `${new Date().toISOString()} ${agent} ${event}: ${(error as Error).message?.slice(0, 300)}\n`, { flag: "a" })
    } catch {
      // Nothing more to do.
    }
  }
}
