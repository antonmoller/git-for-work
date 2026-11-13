#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { Account } from "./account.ts"
import { commands, type Command, type Opts } from "./commands.ts"
import { Context } from "./context.ts"
import { Init } from "./init.ts"
import { Exit, EXIT, isJson, setJson } from "./output.ts"
import { Presence } from "./presence.ts"

const OPTIONS = {
  // Global
  json: { type: "boolean" },
  url: { type: "string" },
  workspace: { type: "string", short: "w" },
  agent: { type: "string" },
  session: { type: "string" },
  help: { type: "boolean", short: "h" },
  // Commands
  for: { type: "string" },
  version: { type: "string" },
  title: { type: "string" },
  wait: { type: "string" },
  base: { type: "string" },
  from: { type: "string" },
  why: { type: "string" },
  revert: { type: "string" },
  fields: { type: "string" },
  out: { type: "string" },
  to: { type: "string" },
  ask: { type: "string" },
  since: { type: "string" },
  by: { type: "string" },
  in: { type: "string" },
  trajectory: { type: "string" },
  limit: { type: "string" },
  as: { type: "string" },
  name: { type: "string" },
  command: { type: "string" },
  scope: { type: "string" },
  "codex-home": { type: "string" },
  peek: { type: "boolean" },
  all: { type: "boolean" },
  "from-start": { type: "boolean" },
  create: { type: "boolean" },
} as const

const all: Record<string, Command> = { ...commands, ...Presence.commands }

function help() {
  const out = ["work: a shared log of what agents did, and claims so they don't overwrite each other.", ""]
  out.push("Account")
  for (const c of Object.values(Account.commands)) out.push(`  work ${c.usage}\n      ${c.summary}`)
  out.push("  work init claude|codex [--scope project|local|user]\n      Sets up an agent's hooks and instructions in this checkout.")
  const groups = new Map<string, Command[]>()
  for (const c of Object.values(all)) groups.set(c.group, [...(groups.get(c.group) ?? []), c])
  for (const [group, list] of groups) {
    out.push("", group)
    for (const c of list) out.push(`  work ${c.usage}\n      ${c.summary}`)
  }
  out.push(
    "",
    "Everywhere: --json, --url <worker>, -w/--workspace <slug>, --agent <name>, --session <id>.",
    "A path in a Git checkout stands for its URL on the remote. Exit codes: 0 ok, 1 refused, 2 usage, 3 sign-in, 4 failed.",
  )
  process.stdout.write(out.join("\n") + "\n")
}

async function main(argv: string[]) {
  // Hooks read their own input and must never fail on unexpected flags.
  if (argv[0] === "hook") return Init.hook(argv[1], argv[2], argv.slice(3))

  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw new Exit(EXIT.usage, `${(error as Error).message}. See: work help`)
  }
  const { values, positionals } = parsed
  setJson(!!values.json)
  const flags = { url: values.url, workspace: values.workspace, agent: values.agent, session: values.session }
  const opts = values as Opts
  const [name, ...args] = positionals

  if (!name || name === "help" || (values.help && !name)) return help()
  if (name === "__presence") {
    const ctx = await Context.make(flags)
    return Presence.hold(ctx, args[0]!, args[1]!, Number(args[2] ?? 0))
  }
  if (name === "init") return Init.init(flags, args, opts)
  const bare = Account.commands[name]
  if (bare) {
    if (values.help) return void process.stdout.write(`work ${bare.usage}\n  ${bare.summary}\n`)
    return bare.run(flags, args, opts)
  }
  const command = all[name]
  if (!command) throw new Exit(EXIT.usage, `No command ${name}. See: work help`)
  if (values.help) return void process.stdout.write(`work ${command.usage}\n  ${command.summary}\n`)
  const ctx = await Context.make(flags)
  try {
    await command.run(ctx, args, opts)
  } finally {
    ctx.dispose()
  }
}

try {
  await main(process.argv.slice(2))
  process.exit(EXIT.ok)
} catch (error) {
  const exit = error instanceof Exit ? error : new Exit(EXIT.failed, (error as Error)?.message ?? String(error))
  if (isJson()) {
    const data = exit.data as { _tag?: string } | undefined
    process.stdout.write(JSON.stringify({ error: { code: exit.code, tag: data?._tag ?? null, message: exit.message, data: data ?? null } }, null, 2) + "\n")
  } else process.stderr.write(exit.message + "\n")
  process.exit(exit.code)
}
