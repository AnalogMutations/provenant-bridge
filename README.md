# @provenant/bridge

Local bridge for [Provenant](https://provenanthq.com).

Reads your Claude Code transcripts from `~/.claude/projects/`, calls Claude on
your existing Pro/Max subscription via the `claude` CLI, and exposes a small
HTTP API on `127.0.0.1:7765` that the website can call.

Nothing leaves your machine: transcripts, prompts, and results all stay local.
The bridge listens on loopback only.

## Install

```bash
npm install -g github:AnalogMutations/provenant-bridge
```

Requires [Node.js 18+](https://nodejs.org) and
[Claude Code](https://docs.claude.com/en/docs/claude-code) on `PATH`.

## Run

```bash
provenant serve
```

Leave the terminal open. Visit
[provenanthq.com](https://provenanthq.com/demo/) and click **Match against my
history**. Stop the bridge with `Ctrl-C` when you're done.

## What it does

- `GET /health` — service info; the website probes this silently to detect
  the bridge.
- `GET /projects` — list of local Claude Code projects with stats.
- `POST /match` — runs the role-match pipeline: reads transcripts, builds a
  compact evidence blob, subprocess-es `claude -p`, returns a structured
  match report.

All non-health endpoints honour an optional bearer token (`--token`) if you
want stricter local auth. CORS is restricted to provenanthq.com plus any
loopback origin.

## Other commands

```bash
provenant projects --since 30d              # list recent projects
provenant match --role privacy-eng --jd ./role.md --since 90d
provenant --help
```

## Privacy & security

- The `claude` CLI handles auth — the bridge never holds API keys or
  credentials.
- Token cost is paid by your Pro/Max subscription, not by Provenant.
- The bridge binds to `127.0.0.1` only. Other devices on your network
  cannot reach it.
- `CLAUDECODE` is scrubbed from the child process so the bridge can be
  invoked from inside another Claude Code session (e.g. its terminal panel).
- Open source. Inspect the source before running.

## License

Proprietary © Analog Mutations.
