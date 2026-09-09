# Session archives

pi's built-in `/export` and `/import` move the conversation. pie's `/session export` moves the
conversation **and** its automation. pi-loops provides that as `/session-export` and
`/session-import` (pi already owns `/session`), in pie's `.piesession` layout plus loop state:

```text
pi-session-<id>.pisession        uncompressed ustar, mode 0600, never overwrites
  manifest.json                  schema, timestamps, pi / pi-loops versions, source, sha256 of session.jsonl, sensitivity flags
  session.jsonl                  pi's session file, verbatim
  sidecars/cron.json             this project's cron jobs           (optional; dropped by --exclude-triggers)
  sidecars/triggers.json         this project's trigger rules       (optional; dropped by --exclude-triggers)
  loops/<job-id>.md              loop state per stateful job        (optional; follows the jobs)
```

```text
/session-export [path] [--exclude-triggers]
/session-import <path> [--activate-triggers=on|off] [--cwd <dir>] [--resume]
```

Both commands print pie's sensitivity warning before doing anything, success or failure.
Import writes a new session file (fresh id, target cwd, `importedFrom` provenance in the header,
the source machine's parent-session pointer dropped)
into this project's session directory and rewrites the sidecars as pie does: automation disabled
unless `--activate-triggers=on`, running markers / errors / overlap counters cleared, ids
regenerated when they collide with existing ones (loop state follows the new id), non-stateful jobs
rebound to the imported session. Afterwards you are asked once whether to re-enable what was
enabled in the source. `--resume` switches to the imported session; otherwise `pi --session <path>`.

Validation: manifest schema, session checksum, path traversal, and size caps (session 50 MiB,
sidecars 2 MiB). Every sidecar is validated before the session file is written, and store writes
are rolled back if one fails, so a rejected archive leaves nothing behind (pie stages, then commits). Archives contain the full transcript and tool history; treat them as sensitive.
They never contain credentials, MCP config or the inbox. Note that pi writes a session file only
after the first message, so an empty session has nothing to export.

## /share — the transcript as a gist

pie's `/share` renders the transcript to Markdown and runs `gh gist create`, borrowing the GitHub
CLI's credentials so nothing new has to hold one. pi-loops does the same, with two changes:

```text
/share            secret gist (unlisted; anyone with the link can read it)
/share --public   public gist
```

Everything goes through the same redactor the rest of pi-loops uses (`src/redact.ts`), and the
command shows what it is about to publish — messages, tool results, size, how many secrets it
masked, and the path of the local copy in `<loops dir>/shares/` — then asks. Declining leaves the
rendered file on disk and uploads nothing. `gh` must be installed and logged in (`gh auth login`);
the gist is created by your account, and `gh gist delete <id>` removes it.

The redactor is a net, not a guarantee. It knows the common shapes — provider keys, bearer tokens,
JWTs, PEM blocks, `NAME=value` and `name: value` pairs whose name mentions a token, secret,
password or key — and it does not know your employer's key format. A secret wrapped across two
lines of tool output is two strings as far as it is concerned, and neither half matches. A
transcript contains every file the agent read and every command it ran, so "0 secrets masked"
means nothing matched, not that there is nothing in there. Read the local copy first — that is why
the command writes one before asking.
