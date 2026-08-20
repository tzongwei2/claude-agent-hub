# Vision

## What this is

A beautiful local hub for talking to several Claude Code agents at once.

Claude Code is excellent in a terminal, but a terminal holds one conversation at
a time. If you keep an infrastructure agent, a frontend agent and a reviewer
going in parallel, you end up juggling tabs, losing track of which one is
waiting on you, and missing the moment one of them asks for permission.

This app is the missing surface. It looks like Teams or Slack, and each
"contact" in the sidebar is a real, independent Claude Code process with its own
working directory and its own memory.

## What it is not

**Not a wrapper around Claude's intelligence.** Claude Code keeps ownership of
its tools, MCP servers, permission rules, filesystem access and session history.
This app never re-implements any of it.

**Not an orchestrator.** No agent-to-agent delegation, no DAG editor, no
automatic planner/coder/reviewer pipeline. Agents are independent by design.
If you want two of them to collaborate, you are the one who carries the message
across — and that is a feature, not a gap.

**Not a hosted product.** Local-first, bound to `127.0.0.1`, single user, no
auth, no cloud. Your code and credentials never leave your machine.

So the whole thing is really: **a UI and a process manager.** Everything
difficult is still Claude Code's job.

## Principles

1. **Claude Code owns the intelligence.** We own the pixels and the processes.
   When the two disagree, we change.
2. **Never bypass the permission system.** Nothing is auto-approved. An
   unanswered prompt is *denied* after five minutes, never allowed.
3. **Structured interfaces only.** We parse Claude Code's documented
   stream-json output. No screen-scraping of terminal text, ever.
4. **The browser cannot name a command.** It picks a configured agent, sends
   chat text, and answers permission prompts. Nothing else crosses the wire.
5. **Never silently lose a message.** If something cannot be delivered, it is
   surfaced in the chat, not swallowed.
6. **Don't invent numbers.** If a figure isn't in the stream, we show what we
   actually know instead of a plausible-looking guess. (See usage, below.)
7. **The database is a cache, not a truth.** Claude Code holds the real
   transcript. Ours exists so the browser has something to paint, which is why
   it can be pruned freely.

## Where it is today

Working, verified against a live Claude Code session:

- Multiple independent agents, running concurrently without blocking each other
- Streaming responses, token by token
- Collapsible tool calls with human summaries instead of raw terminal dumps
- Interactive permission prompts — the agent genuinely pauses until you answer
- Sessions that survive a browser refresh, and resume across restarts
- SQLite persistence with a bounded ring buffer
- Usage visibility: warning light, hard stop, trip meter (below)

## Clearing context

The Clear button runs Claude Code's own `/clear` down the same stdin channel as
your messages. The CLI intercepts it locally, so it costs **zero tokens**, keeps
the same process and the same session id.

Nothing is deleted. A `cleared` marker row is written and `listEvents` reads
from the most recent marker onward, so the pane empties while history stays on
disk and ages out through the ring buffer.

Three cases, because getting this wrong desynchronises the UI from what the
model actually remembers:

| Agent state | Behaviour |
| --- | --- |
| Idle | Clears immediately |
| Mid-turn | Interrupts, then clears once the turn settles |
| Stopped | Persists the intent in SQLite; applied on next start |

`/clear` does **not** erase anything written to disk — files, `CLAUDE.md`, or
memory notes survive it.

## Usage visibility

Three mechanisms, all built from data Claude Code already reports on every turn.
Displaying them costs **zero extra tokens** — the events arrive whether or not
we read them.

**1. The warning light.** Claude reports its rate-limit state each turn. While
it reads `allowed`, the UI stays quiet. Any other value raises a banner
immediately.

**2. The hard stop.** If a turn is actually refused, the reason is surfaced in
the chat as a distinct rate-limit error rather than a generic failure.

**3. The trip meter.** Every turn's token counts are recorded locally and summed
over the current rolling window, broken down per agent, with a reset countdown.

Deliberately **no percentage**. The denominator is not published anywhere in the
stream, so a progress bar would be fabricated. A bar appears only when a real
ceiling is supplied. See the TODOs.

## TODOs

### 1. Calibrate the rate-limit warning states (blocked on observation)

**What we know:** `rate_limit_info.status` has only ever been observed as
`"allowed"` on this account. The full field shape is:

```json
{ "status": "allowed", "resetsAt": 1787250000, "rateLimitType": "five_hour",
  "overageStatus": "rejected", "overageDisabledReason": "org_level_disabled",
  "isUsingOverage": false }
```

**What we don't know:** what `status` becomes when approaching or hitting the
limit. The banner currently treats *anything* other than `allowed` as a warning,
which is safe but coarse — it cannot distinguish "getting close" from "blocked".

**To do once a non-`allowed` value is seen:**

- Record the exact string and the conditions that produced it
- Give approaching-limit and blocked states distinct colours and copy
- Check whether `isUsingOverage` ever flips (it cannot on this account —
  `overageDisabledReason: org_level_disabled`)
- Decide whether a warning state should auto-pause running agents

### 2. Learn the real token ceiling (user will supply)

**The user will report the actual percentage from `/usage` next to a known
token total.** With one such data point we can estimate the denominator and turn
the trip meter into a real progress bar.

Procedure when that arrives:

1. Read the current window total from the hub — the trip meter figure
2. Run `/usage` in a terminal and note the reported percentage
3. `ceiling ≈ hub_tokens / (percentage / 100)`
4. Store it as the default `tokenBudget`, and refine with further data points

Notes for whoever does this:

- The hub counts `input + output + cache_creation` and **excludes cache reads**,
  which are cheap and would swamp the figure. If the estimate looks far off,
  cache-read accounting is the first thing to re-check.
- Claude's limit is very likely not a flat token count — model, cache state and
  request shape probably all weigh in. Treat any derived ceiling as a
  calibrated guess and label it that way in the UI.
- Once a ceiling exists, wire the estimate into the meter's `budget` prop
  (already supported; currently read from `localStorage.tokenBudget`).

### 3. Smaller things

- Settings UI for the token budget instead of hand-setting `localStorage`
- Session dividers in the chat when a new Claude session begins
- Per-agent MCP configuration
- Desktop notifications for permission prompts
- Verify the UI in a real browser — it has been checked via build, typecheck
  and SSR output, but never actually looked at
