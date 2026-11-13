export * as Account from "./account.ts"

import { Auth } from "./auth.ts"
import { Config } from "./config.ts"
import { Context, type Flags } from "./context.ts"
import { Exit, EXIT, info, print } from "./output.ts"
import type { Opts } from "./commands.ts"
import type { Views } from "@work/schema/views"

/** Commands that run before, or without, a signed-in client. */
export interface Bare {
  readonly usage: string
  readonly summary: string
  readonly run: (flags: Flags, args: string[], opts: Opts) => Promise<void>
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined)

const openBrowser = (link: string) => {
  if (process.env.WORK_NO_BROWSER) return
  const cmd = process.platform === "darwin" ? ["open", link] : process.platform === "win32" ? ["cmd", "/c", "start", "", link] : ["xdg-open", link]
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" })
  } catch {
    // No browser: the link is printed.
  }
}

const whoami = async (flags: Flags) => {
  const ctx = await Context.make(flags)
  try {
    return { ctx, me: await ctx.me() }
  } finally {
    ctx.dispose()
  }
}

const describe = (me: Views.Me, flags: Flags, ctx: Awaited<ReturnType<typeof Context.make>>) =>
  [
    `${me.actor.name} (${me.actor.handle}, ${me.email}), ${me.role} in ${me.org}, on ${ctx.url}.`,
    ctx.who.agent ? `Agent ${me.actor.handle}/${ctx.who.agent}, session ${ctx.who.session}${ctx.who.ownSession ? ` (joined; own ${ctx.who.ownSession})` : ""}.` : "No agent session here: commands that change things need one.",
    `Workspace: ${flags.workspace ?? Config.workspaceFor() ?? (me.workspaces.length === 1 ? me.workspaces[0]!.slug : "none chosen")}.`,
  ].join("\n")

export const commands: Record<string, Bare> = {
  login: {
    usage: "login [--url <worker>] [--as <handle> [--name <name>]]",
    summary: "Signs in with WorkOS in the browser. --as signs in as anyone on a local server.",
    async run(flags, _args, opts) {
      const url = Config.url(flags.url)
      try {
        const as = str(opts.as)
        if (as) await Auth.loginDev(url, as, str(opts.name))
        else await Auth.loginDevice(url, info, openBrowser)
      } catch (error) {
        throw new Exit(EXIT.auth, (error as Error).message)
      }
      if (flags.url) Config.saveSettings({ ...Config.settings(), url })
      const { me, ctx } = await whoami(flags)
      print(`Signed in.\n${describe(me, flags, ctx)}`, me)
    },
  },
  logout: {
    usage: "logout",
    summary: "Forgets this machine's sign-in.",
    async run(flags) {
      const url = Config.url(flags.url)
      await Auth.logout(url)
      print(`Signed out of ${url}.`, { url })
    },
  },
  whoami: {
    usage: "whoami",
    summary: "The person, the agent and session this command runs as, and the workspace.",
    async run(flags) {
      const { me, ctx } = await whoami(flags)
      print(describe(me, flags, ctx), { ...me, agent: ctx.who.agent, session: ctx.who.session, ownSession: ctx.who.ownSession, url: ctx.url })
    },
  },
  workspaces: {
    usage: "workspaces",
    summary: "The workspaces in your organization.",
    async run(flags) {
      const { me } = await whoami(flags)
      const chosen = Config.workspaceFor()
      if (me.workspaces.length === 0) return print("No workspaces yet. Create one: work use <slug> --create", me.workspaces)
      print(me.workspaces.map((w) => `${w.slug === chosen ? "*" : " "} ${w.slug.padEnd(20)} ${w.name}`).join("\n"), me.workspaces)
    },
  },
  use: {
    usage: "use <workspace> [--create] [--name <name>]",
    summary: "Uses a workspace for this directory and the ones below it.",
    async run(flags, [slug], opts) {
      if (!slug) throw new Exit(EXIT.usage, `Usage: work ${this.usage}`)
      const ctx = await Context.make(flags)
      try {
        const me = await ctx.me()
        if (!me.workspaces.some((w) => w.slug === slug)) {
          if (!opts.create) throw new Exit(EXIT.usage, `No workspace ${slug}. Create it with: work use ${slug} --create`)
          await ctx.call((c) => c.account.createWorkspace({ payload: { slug, name: str(opts.name) ?? slug } }))
          info(`Created ${slug}.`)
        }
      } finally {
        ctx.dispose()
      }
      Config.useWorkspace(slug)
      print(`Using ${slug} in ${process.cwd()}.`, { workspace: slug, dir: process.cwd() })
    },
  },
}
