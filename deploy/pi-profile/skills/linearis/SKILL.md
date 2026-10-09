---
name: linearis
description: >-
  Manage Linear.app work from the command line with the linearis CLI (bins
  linearis / linear), which outputs JSON: issues/tickets, projects, cycles
  (sprints), milestones, initiatives (roadmap), documents, labels, teams,
  users, and issue discussions/comments. Use when the user mentions Linear, a
  ticket identifier like ENG-42 or ABC-123, sprints, triage, or the roadmap, or
  asks to create, read, search, update, assign, comment on, or otherwise manage
  Linear issues and projects.
license: MIT
compatibility: Requires the linearis CLI (npm i -g linearis), Node >=22, and a Linear API token.
allowed-tools: Bash(linearis:*), Bash(linear:*), Bash(jq:*)
metadata:
  author: linearis-oss
  version: "1.0.0"
---

# linearis

Drive [Linear.app](https://linear.app) from the shell via the `linearis` CLI
(JSON-only output; `linear` is an alias). Do not guess the command surface — the
CLI documents itself, and this skill teaches the protocol, not the flags.

## Preflight (reactive — branch on the CLI's own output; don't pre-run checks every turn)

- **Not installed** — if the shell reports command-not-found, tell the user
  linearis isn't installed and offer `npm install -g linearis`. As a no-install
  fallback, prefix commands with `npx linearis@latest` (adds cold-start latency
  and needs network per call — fallback, not default). Never silently
  `npm install -g`.
- **Auth required** — any command may fail with this envelope on stderr and
  exit code 42: `{ "error": "AUTHENTICATION_REQUIRED", "action":
  "USER_ACTION_REQUIRED", "instruction": "Run 'linearis auth login' …",
  "exit_code": 42 }`. Detect it by `exit_code === 42` / `error ===
  "AUTHENTICATION_REQUIRED"` (not paraphrased text) and surface the CLI's own
  `instruction`. `linearis auth login` is an interactive browser flow you
  cannot complete — hand it to the user.
- **Invalid invocation** — an unknown command or option, a wrong argument
  count, or a command group named without a subcommand fails on stderr with
  exit code `2`. Recover from the JSON envelope, not by guessing: pick from
  `available_commands`, or run its `instruction`. A bare group such as
  `linearis issues` is a failure, not a request for help.
- **Updates (advisory, never blocking)** — optionally run `linearis version
  check` once. If an update is available, mention it and ask the user before
  upgrading. Read the installed version with `linearis version`, not
  `--version`.

## Discover, then act

1. Run `linearis usage` once for the list of domains.
2. Run `linearis <domain> usage` for that domain's command and flag reference
   before acting.
3. Never invent flags or subcommands — `usage` is authoritative and current.

## Output

Every command prints JSON on stdout. Shape it at the source with the global
`--fields identifier,title,state.name` and `--compact`. Use `jq` only for
complex reshaping, and fall back to raw JSON if `jq` is absent.

## Invariants worth knowing

- IDs are forgiving: pass a UUID, team key (`ENG`), issue identifier
  (`ABC-123`), or name interchangeably. Reference tickets by identifier.
- `issues create` requires `--team`; some filters need a scope flag — confirm
  in `usage` rather than memorizing.
- Threaded discussion lives under `issues discuss` / `discussions` / `replies`
  / `reply`. The top-level `comments` domain is deprecated; prefer the issue
  discussion commands.
- `files download <url>` only fetches Linear storage URLs. `files upload`
  returns an asset URL, and `issues read --with-attachments` lists linked
  resources rather than guaranteeing they are downloadable files.

For anything not covered here, `linearis <domain> usage` is the reference.
