# Delegation and model routing

`pi-subagents` is installed for focused delegation. Use it when a fresh context,
parallel read-only investigation, bounded implementation, or independent review
is worth the coordination overhead. Do not delegate trivial work.

- Use `scout` to map an unfamiliar area before changing it.
- For implementation, choose exactly one writer per workspace. Pick the writer
  by context mode, then choose the model tier per run:
  - Default to `worker` (GLM-5.3-Flash, fresh context) for routine, localized,
    reversible work with clear acceptance criteria.
  - Use `worker-fork` (GLM-5.3-Flash, forked context) when an established
    pattern, follow-up, or cleanup should inherit the parent's verified
    conversation instead of re-deriving a brief. Fork re-processes the inherited
    transcript every turn, so prefer the fresh `worker` unless that context is
    genuinely valuable.
  - For consequential work involving architecture, security/auth, concurrency,
    persistence or migrations, multiple subsystems, difficult debugging, or a
    Flash worker that stalled or failed verification, use either writer with
    the per-run model `together/zai-org/GLM-5.3`.
- Model cost alone must not route consequential work to Flash. Pass prior
  evidence forward when escalating, and never run two implementation writers
  against the same workspace concurrently.
- Use fresh `reviewer` agents after meaningful changes; the parent synthesizes
  findings and owns any follow-up edits.
- Use `oracle` for a second opinion on a consequential decision before acting.
- Keep delegated tasks narrow, state their non-goals, and require concrete
  evidence in the result.

# PR monitoring

`pr-watch` is installed as a user agent with a `/pr-watch` prompt. Use
`/pr-watch <pr> [deadline-sec]` to launch the background watcher after opening
or updating a pull request. It wakes the parent for actionable review activity,
CI failure, CI settlement, merge conflict, or deadline. After launching it,
return control to the user; do not add a foreground polling loop.

A watcher is running only when the background launch returns a successful run
identifier. If it throws, reports that background children are unavailable, or
otherwise fails to return a run identifier, say so prominently in the same
turn; never imply that the PR is being monitored. Foreground subagents still
work in that failure mode. Until background launch succeeds, check `gh pr view`
and `gh pr checks` at every turn boundary and whenever work resumes so review
comments or CI failures do not sit unnoticed.

The hosted environment may not have every repository tool installed. Follow
project instructions, but never claim an unavailable build, lint, or test gate
passed. If a required tool is missing, report the exact missing capability and
the verification that remains outstanding instead of inventing a workaround.

# Resource discipline

This is a persistent interactive workspace, not a CI runner. Prefer the
smallest check that answers the task:

- Do not build Falcon, run a full monorepo build, or install the complete
  monorepo dependency closure unless the user's task specifically requires it.
- Prefer package-scoped lint, typecheck, tests, and benchmarks. Reuse existing
  artifacts when their provenance is adequate for the question.
- If a broad build is genuinely necessary, explain why first and use the
  repository's lowest practical concurrency (one worker for memory-heavy
  TypeScript builds). Exit code 245 or a sudden memory spike is a reason to stop
  and narrow the work, not to retry at full parallelism.

# Repository tooling

`pnpm` and Moon are installed globally and available to non-interactive agent
shells. The hosted Moon version is 2.5.5, matching Siro's current
`.prototools` pin. Prefer a repository-local tool version when one is present,
and report a pin mismatch rather than silently changing the repository's
toolchain configuration.

# Linear

Linearis is installed as the `linearis` command (with `linear` as an alias), and
its managed skill documents the discover-then-act protocol. Start with
`linearis usage`, then run `linearis <domain> usage` before acting; do not guess
subcommands or flags.

Authentication comes from the Railway `LINEAR_API_TOKEN` secret. Never print,
persist, commit, or pass the token as a command-line argument. If Linearis exits
with code 42 or `AUTHENTICATION_REQUIRED`, report that the Railway variable is
missing or invalid instead of attempting an interactive login. Keep mutations
within the user's request and confirm destructive Linear operations before
executing them.

# Rust toolchain (this environment)

Rust is installed with rustup under the persistent `/data/home/.cargo` and
`/data/home/.rustup` directories. Stable Rust 1.99.0, `rustfmt`, `clippy`, the
`wasm32-unknown-unknown` target, `cargo-binstall`, and
`wasm-bindgen-cli@0.2.122` are available. The deployment exposes their commands
through `/data/pi-agent/bin`, including to non-interactive agent shells that do
not read a Bash startup file.

Do not put Cargo build output on `/data`: the persistent volume is shared with
workspaces and home state, and a large debug target can exhaust it. Before the
first Cargo command in each checkout, use a disposable target on the container
filesystem while preserving tools that expect `<repo>/target/...`:

```bash
mkdir -p /var/tmp/cargo-target
if [[ -e target && ! -L target ]]; then
  printf '%s\n' 'target exists and is not a symlink; inspect it before continuing' >&2
  exit 1
fi
ln -sfnT /var/tmp/cargo-target target
exclude_file="$(git rev-parse --git-path info/exclude)"
grep -qxF /target "$exclude_file" || printf '/target\n' >>"$exclude_file"
```

The deployment recreates `/var/tmp/cargo-target` after a container rebuild, but
its contents are intentionally disposable. The checkout's symlink persists. If
`target` is a real directory rather than a symlink, inspect it before replacing
it; never recursively delete an unresolved or unexpected path.

Prefer package-scoped Rust checks and low build concurrency. Do not build the
full Siro workspace or Falcon unless the task actually requires it.
