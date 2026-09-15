# Goals: holding a session to a stop condition

`/goal` is a stop condition the session is held to, and the only mechanism
here that asks "am I done yet". Cron jobs, loops and triggers all run on a clock or an event; a goal
runs on a judgement.

```
/goal the test suite passes and the changes are committed
```

After every settled turn an evaluator — a model call with no tools, reading only a bounded
transcript of the whole conversation on the active branch — answers one question: is the condition
satisfied? Evidence from an earlier turn counts: the evaluator sees the session, not just the run
that happened to end. It must reply in a fixed shape,
quoting the transcript:

```json
{"ok": true,  "reason": "npm test reported 0 failures"}
{"ok": false, "reason": "3 tests still fail in parser.test.ts"}
```

`ok: false` sends the agent back to work with what is missing, as a normal user turn. `ok: true`
stops and shows the evidence. Missing evidence is not success: an evaluator with nothing to point at
is told to answer `{"ok": false, "reason": "insufficient evidence in transcript"}`.

## What bounds it

| Guard | Behaviour |
|---|---|
| Continuations | At most 8, then the goal is `budget_limited` and pauses |
| Evaluator failure | Pauses with the reason; it never loops on an evaluator that cannot decide |
| Transcript | 40 000 characters, truncated from the front so the newest evidence always survives |
| Tools | None. The evaluator reads, it does not act |
| Interruption | Esc on a turn pauses the goal — it stays paused across `--resume` until `/goal resume` — and Esc during an evaluation stops that evaluation the same way |
| Its own timeout | 2 minutes; it is one read, not a piece of work |

`/goal resume` after a budget limit starts the allowance again, and after an Esc starts
evaluating again: stopping a turn is taken as stopping the goal, since the next message you sent
would otherwise end with the evaluator sending the agent back to work. `pause`, `resume` and `clear` are
matched as whole words, so `/goal clear the type errors first` sets that as the condition rather
than dropping the goal.

## Commands

```
/goal <condition>     hold this session to a condition (then send a prompt to begin)
/goal                 show the condition, the status, and what the evaluator last said
/goal pause           stop evaluating, keep the condition
/goal resume          start evaluating again
/goal clear           drop the goal
```

## Where it lives

Each state change is appended to the session as a `goal_state` entry, so `--resume` picks the goal
up where it left off. The status line shows `goal: <status>`; the
statuses are `pursuing`, `paused`, `achieved`, `budget_limited` and `cleared` (what `/goal clear`
leaves behind).

The evaluator runs as a sub-agent with the session's model, so it is billed like any other run and
its transcript is kept with them.
