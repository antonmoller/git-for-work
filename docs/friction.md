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

Exercises 1–4 were run in full. The run stopped at the hand-off (5) when opencode went idle and the coordinating
session lost its connection. Each finding below says what happened and what changed.

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
