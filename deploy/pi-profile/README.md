# Managed hosted Pi profile

This directory contains the small, non-secret Pi profile copied into the
persistent Railway agent directory when the service starts.

Only operator guidance, agent definitions and helpers, and pinned Pi package
declarations belong here. Never add API keys, tokens, passwords, SSH keys,
`auth.json`, session data, trust decisions, extension run state, or generated
package contents. Secrets belong in Railway variables and mutable state belongs
on the `/data` volume.

Files in this directory are deployment-owned and may replace their matching
managed destinations on startup. The bootstrap must not mirror or delete the
rest of the Pi agent directory.

The hosted model policy keeps the interactive and subagent defaults on
GLM-5.3. `scout`, the builtin fresh-context `worker`, the managed fork-context
`worker-fork`, and cheap polling agents such as `pr-watch` use GLM-5.3-Flash.
Consequential work upgrades either worker per run to GLM-5.3, keeping context
mode and model tier as separate choices.

`worker-fork.md` intentionally copies the upstream worker contract to change
its context default. Recompare it with the builtin worker after significant
`pi-subagents` upgrades.

The hosted Rust toolchain remains under the persistent `/data/home` tree rather
than being duplicated in the application image. Startup restores its
non-interactive PATH links and the disposable `/var/tmp/cargo-target` directory;
the managed `AGENTS.md` documents the per-checkout target symlink required to
keep large build artifacts off the Railway volume.

The Railway image also pins Moon 2.5.5 (matching Siro's `.prototools` pin) and
Linearis 2026.8.0. A hosted adaptation of the Linearis skill from tag
`v2026.8.0` is vendored under `skills/linearis`; recompare it when upgrading the
CLI. Authentication is supplied only at runtime through the Railway
`LINEAR_API_TOKEN` secret and must never be added to this profile.
