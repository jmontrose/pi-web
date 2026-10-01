# Delegation

`pi-subagents` is installed for focused delegation. Use it when a fresh context,
parallel read-only investigation, bounded implementation, or independent review
is worth the coordination overhead. Do not delegate trivial work.

- Use `scout` to map an unfamiliar area before changing it.
- Use `worker` for a clearly bounded implementation with one writer per
  workspace.
- Use fresh `reviewer` agents after meaningful changes; the parent synthesizes
  findings and owns any follow-up edits.
- Use `oracle` for a second opinion on a consequential decision before acting.
- Keep delegated tasks narrow, state their non-goals, and require concrete
  evidence in the result.

The hosted environment may not have every repository tool installed. Follow
project instructions, but never claim an unavailable build, lint, or test gate
passed. If a required tool is missing, report the exact missing capability and
the verification that remains outstanding instead of inventing a workaround.
