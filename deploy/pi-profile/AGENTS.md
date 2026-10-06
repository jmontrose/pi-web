# Delegation and model routing

`pi-subagents` is installed for focused delegation. Use it when a fresh context,
parallel read-only investigation, bounded implementation, or independent review
is worth the coordination overhead. Do not delegate trivial work.

- Use `scout` to map an unfamiliar area before changing it.
- For implementation, choose exactly one writer per workspace:
  - Default to `worker` for routine, localized, reversible work with clear
    acceptance criteria. It is the inexpensive GLM-5.3-Flash path.
  - Choose `worker-strong` immediately when the work affects architecture,
    security/auth, concurrency, persistence or migrations; crosses multiple
    subsystems; requires difficult debugging; or the user asks for the
    strongest or most thorough implementation. It uses full GLM-5.3.
  - Escalate from `worker` to `worker-strong` if the light worker stalls,
    returns an uncertain result, or fails verification. Pass the first
    worker's evidence forward; do not run two implementation writers against
    the same workspace concurrently.
- Model cost alone must not route consequential work to `worker`.
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
