# Session archives

pi's built-in `/export` and `/import` move the conversation. pie's `/session export` moves the
conversation **and** its automation. pi-loops provides that as `/session-export` and
`/session-import` (pi already owns `/session`), in pie's `.piesession` layout plus loop state:

```text
pi-session-<id>.pisession        uncompressed ustar, mode 0600, never overwrites
  manifest.json                  schema, timestamps, pi / pi-loops versions, source, sha256 of session.jsonl, sensitivity flags
  session.jsonl                  pi's session file, verbatim
  sidecars/cron.json             this project's cron jobs           (optional)
  sidecars/triggers.json         this project's trigger rules       (optional; --exclude-triggers)
  loops/<job-id>.md              loop state per stateful job        (optional)
```

```text
/session-export [path] [--exclude-triggers]
/session-import <path> [--activate-triggers=on|off] [--cwd <dir>] [--resume]
```

Import writes a new session file (fresh id, target cwd, `importedFrom` provenance in the header)
into this project's session directory and rewrites the sidecars as pie does: automation disabled
unless `--activate-triggers=on`, running markers / errors / overlap counters cleared, ids
regenerated when they collide with existing ones (loop state follows the new id), non-stateful jobs
rebound to the imported session. Afterwards you are asked once whether to re-enable what was
enabled in the source. `--resume` switches to the imported session; otherwise `pi --session <path>`.

Validation: manifest schema, session checksum, path traversal, and size caps (session 50 MiB,
sidecars 2 MiB). Archives contain the full transcript and tool history; treat them as sensitive.
They never contain credentials, MCP config or the inbox. Note that pi writes a session file only
after the first message, so an empty session has nothing to export.
