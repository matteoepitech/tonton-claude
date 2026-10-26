---
name: release
description: Checklist for cutting a Tonton Claude release (app DMG, agents, relay, install scripts) from a signed version tag. Maintainer only.
disable-model-invocation: true
---

# Cutting a release

Only the maintainer tags. An agent prepares, checks and writes the commands; the maintainer runs them, because the tag
is signed with their key.

## Before the tag

1. `main` is green on CI: `gh run list --branch main --workflow ci.yml -L 1`.
2. Pick the version from the changes since the last tag (`git log $(git describe --tags --abbrev=0)..main --oneline`):
   a new feature bumps the minor, fixes only bump the patch.
3. Look for anything that needs an order of updates:
   - `relay/` changed: self-hosters must update the relay. Does the new app still work with the previous relay?
   - `shared/protocol.ts` changed: see the version table in the `protocol-change` skill.
   - The agent changed: users get **Update agent** in the app; agents older than 0.4.0 need the install command again.
4. Draft the release notes: what users see, then what self-hosters must do.

## Tag

```sh
git switch main && git pull --ff-only
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

`.github/workflows/release.yml` then publishes the DMG, the agents, the relay executables and Docker image, the install
scripts and `SHA256SUMS`.

## After

- The workflow is green and the release has every asset listed in the workflow.
- Install the DMG on a Mac and check that **Update agent** appears for a machine on the previous version.
- If the relay changed, update the hosted relay with `install-relay.sh` (see `docs/self-hosting.md`).
