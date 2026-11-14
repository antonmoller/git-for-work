# What two agents found using Work

Claude and opencode ran seven exercises against the dev stage (2026-11-13), on `playground/menu.csv` and
`playground/specials.json` in one shared checkout:

1. a race;
2. a claim queue;
3. asking a question by URL;
4. asking for a revert;
5. a hand-off;
6. joining another agent's session;
7. comment, blame and diff.

Exercises 1–4 were run first; opencode finished 5–7 after a restart, and a retry on 2026-11-14 checked the fixes
(see [Retry](#retry-after-the-fixes)). Each finding below says what happened and what changed.

## Serious

**A bare `put` overwrote both agents' edits.** Opencode wrote v3 from a private copy, then ran `work put
playground/menu.csv` without `--from` or `--base`. The default base is the session's last version, which was v3, so
the base check passed. The content, though, was the stale checkout file, and it went in as v4, dropping both edits.
*Fixed:* the workspace refuses a write whose content is an earlier version's (`StaleContent`, exit 1), unless it is a
revert. The message names the version it matches and how to get the latest.

**The inbox went to whichever conversation read it first.** A conversation that took over another's Work session (by
exporting its `WORK_SESSION`) shared one inbox cursor with the original. The original's hooks kept running, so
opencode's question was marked read in a conversation that no longer did the work. *Fixed:* every `work` command
records which agent process drives its session (`drivers.json` in the Work home). A hook delivers a session's inbox
only to the conversation that most recently drove it, and a conversation that took over a session gets that session's
inbox and tool steps.

**`revert --ask` from an agent arrived as the person.** The request read "Anton Möller asks you to revert", so the
receiver could not tell an agent had asked. *Fixed:* the request keeps the asking agent; from the app it is still the
person.

**An idle agent cannot be woken.** `tell` and `ask` reach an agent only on its next prompt or tool call, so every round
needed a person to prompt opencode. *Fixed, as far as the CLI can:* `work wait [--for 30m]` blocks until something
reaches the inbox, prints it and exits. In the background in Claude Code, its exit wakes the agent. The agent
instructions now say to use it when waiting on another agent. An agent that is not running at all still needs a person
or a scheduler.

## Smaller

**Writing identical content made a new version.** *Fixed:* `put` of the current content writes nothing and says "No
change: vN already has this content".

**`put --from <copy>` left the checkout file stale, with no hint.** *Fixed:* `put` says when the checkout file is older
than what it just wrote. `work read <path> --out <path>` brings it up to date; `--out` also saves to any file.

**The revert flow was three steps** (revert, apply, `put --revert`), and its output repeated a CSV row's key ("Put
back C1 C1,Espresso,28") and said "Apply it in the app" for a file. *Fixed:* `work revert <url>@vN --put` puts the
values back and writes the next version in one step, updating the checkout file for a path. The output no longer
repeats the key, and it no longer mentions the app.

**The log counted a CSV's header as a changed row** ("6 changed" for 5 rows). *Fixed.*

## Not changed

- **Claims protect versions in Work, not files on disk.** Two agents in one checkout share the working tree. Each
  should edit a private copy and put it with `--from`; the stale-content refusal now catches the usual mistake.
- **A refused write leaves a trace already.** It is logged as `refused write: StaleBase` and shown in the app's
  feed, so people can see near-misses.

## Worked well

- The stale-base refusal names who wrote since and what to run next.
- Waiting on a claim showed the holder's intent, and the claim was granted 24 s after release, with no polling.
- The hand-off, joining another agent's session and writing as it, and comment, blame and diff (exercises 5–7) all
  worked as expected for opencode.

## Retry after the fixes

On 2026-11-14, against the dev stage with the fixes in `e1d49d0`:

| Check | Result |
| --- | --- |
| Put the current content again | "No change", nothing written |
| Put v7's content on base v8 | Refused, `StaleContent`, exit 1 |
| Bad write, then `revert --put` | One step: v10 written, checkout updated, claim released |
| `put --from <copy>` | Warns that the checkout file is older |
| `revert --ask` from another agent | Arrives as `antonjmoller/codex`, not the person |
| `work wait --for 20m` while the other agent is idle | Timed out: opencode had ended its trajectory and was not waiting |

New findings:

- **Reading an old version moves the base** (serious). `work read <url> --version v7`, to look at history, records a
  read at v7, so the session's default base becomes v7 and its next ordinary `put` of the latest content is refused
  `StaleBase`. *Fixed:* a read of an older version is logged with `older`, and only a read of the then-latest
  version (or a write) becomes the default base (`Session.defaultBase`, property test).
- **`revert --put` leaves a file in the working directory.** Each run left `menu.csv.v<N>.csv` (the reverted
  content) at the repo root, where it is easy to commit by mistake. *Suggested fix:* write it to the Work home's cache,
  or not at all when `--put` writes the result.
- **`work wait` only helps if both agents use it.** An agent that ends its turn without a background `work wait` is
  still unreachable. *Suggested fix:* have `work done` (and the Stop hook) remind an agent with open conversations to
  wait, or start the wait itself when another agent has asked it something in this trajectory.
- **Small wording.** `StaleContent` says "would undo v8–v8" for one version (say "would undo v8"). Hints print
  absolute paths when the command was given a relative one (echo the path as given). The revert request in the inbox
  suggests `work revert …@v11` instead of the one-step `--put` form.

