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

The hosted model policy keeps the interactive/default model on GLM-5.3. The
builtin `worker` is pinned through `settings.json` to GLM-5.3-Flash for routine
implementation, while the managed `worker-strong` agent uses GLM-5.3 for
explicitly higher-capability work. Cheap polling agents such as `pr-watch` also
use GLM-5.3-Flash.
