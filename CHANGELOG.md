# Changelog

All notable changes to pi-loops are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.
Behavior is cross-checked against [pie](https://github.com/c4pt0r/pie) source, file by file.

## [Unreleased]

## [0.1.0] - 2026-09-08

First release. Everything pie ships in its automation layer, as a pure pi extension.

### Added
- `/cron add [--stateful] [--verify] "<schedule>" <prompt>` with pie's list/enable/disable/remove
  surface, schedule aliases (`hourly`, `daily`, `每小时`, …), `every 30m`, `in 10m`, `at <ISO>`.
- Stateful loops: fresh `pi -p` sub-agent per run, ≤2000-char notes carried between runs
  (`<loop-state>`), findings routed to the inbox (`<inbox>`), transcripts kept (`/cron trace`).
- Maker/checker (`--verify`, pie's phase 3): an adversarial second sub-agent keeps or drops each
  finding before it enters the inbox; fail-open on checker failure.
- `/inbox` triage with pie's exact list formats and `new → claimed/dismissed` lifecycle;
  `/inbox claim` starts a real agent turn.
- Dynamic triggers: `/new-trigger`, `/triggers status|rules|sources|enable|disable|remove|running|audit|abort`,
  `new_trigger` / `list_triggers` / `remove_trigger` / `set_trigger_state` tools, periodic sub-agent
  evaluation, fire-once, `promote_to_chat`, `[Trigger <trace>]` prefix, 5-minute dedup window.
- MCP: notification sources (stdio + streamable HTTP) with pie's `mcp.toml` schema, dedup keys,
  redacted summaries, `inject_summary` / `inject_and_run`; server tools registered with the agent.
- Lifecycle hooks (`hooks.toml`): pie's events, payload, `PI_*` and `PIE_*` env, command + webhook,
  sequential execution, process-tree kill on timeout, project hooks gated.
- Session archives: `/session-export` / `/session-import` (`.pisession`, pie's `.piesession`
  layout plus `loops/<id>.md` state files).
- pie-style side panel above the editor (`/cron panel on|off`), `Inbox: N new · running: …`
  status badge, run cards in the transcript.
- Machine-global job store with leader election across pi processes, one-shot catch-up of missed
  ticks (`--no-catchup` to opt out), per-job transcripts, run log, redaction everywhere.

### Differences from pie (deliberate)
- Jobs and rules are machine-global with a `cwd`, not session-scoped; `/cron` and `/triggers rules`
  list the current project by default.
- Missed ticks are caught up once by default; pie never backfills.
- Prompts may be up to 8 KB (pie: 4 KB).
- MCP notifications are consumed by the single process that owns the timer; every process still
  connects for tools.
