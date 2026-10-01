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
