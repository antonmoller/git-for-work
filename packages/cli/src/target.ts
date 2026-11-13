export * as Target from "./target.ts"

import { existsSync, statSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

/** `git@github.com:holm/pricing.git` and `https://github.com/holm/pricing` both become `github.com/holm/pricing`. */
export const remoteBase = (remote: string) =>
  remote
    .trim()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")

/** A file or folder inside a Git checkout, as the URL of the same path on its remote and branch. */
export function fromPath(path: string, cwd = process.cwd()) {
  const full = resolve(cwd, path)
  // A file that was deleted still has its URL, as long as its folder is in a checkout.
  const exists = existsSync(full)
  const isDir = exists && statSync(full).isDirectory()
  const dir = isDir ? full : dirname(full)
  if (!existsSync(dir)) return null
  const root = git(dir, "rev-parse", "--show-toplevel")
  if (!root) return null
  const remote = git(root, "remote", "get-url", "origin") ?? git(root, "remote", "get-url", git(root, "remote")?.split("\n")[0] ?? "origin")
  // A checkout with no remote is named by its folder, as `<folder>.local`, so everyone on the same project agrees.
  const base = remote ? remoteBase(remote) : `${basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "repo"}.local`
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD") ?? "main"
  const rel = relative(root, full).split("\\").join("/")
  const kind = isDir ? "tree" : "blob"
  return `https://${base}/${kind}/${branch === "HEAD" ? (git(root, "rev-parse", "HEAD") ?? "main") : branch}${rel ? `/${rel}` : ""}`
}

/** Whether text names a URL rather than a local path: a scheme, or a host with a dot before the first slash. */
export const looksLikeUrl = (text: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(text)

/**
 * What the agent named: a URL as written (the server normalizes it), or a path in a checkout as its remote URL.
 * `url@v7` splits off the version.
 */
export function resolveTarget(input: string, cwd = process.cwd()): { url: string; version: number | null; path: string | null } {
  const at = input.match(/^(.*)@v(\d+)$/)
  const raw = at ? at[1]! : input
  const version = at ? Number(at[2]) : null
  if (!looksLikeUrl(raw) || existsSync(resolve(cwd, raw))) {
    const fromGit = fromPath(raw, cwd)
    if (fromGit) return { url: fromGit, version, path: resolve(cwd, raw) }
    if (!looksLikeUrl(raw)) throw new Error(`${raw} is not a URL, and not a file in a Git checkout`)
  }
  return { url: /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`, version, path: null }
}
