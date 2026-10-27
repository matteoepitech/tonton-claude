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
5. App updates: `gh variable list` shows `SPARKLE_PUBLIC_KEY` and `gh secret list` shows `SPARKLE_PRIVATE_KEY`. Without
   both, the release ships without an `appcast.xml` and that version of the app never updates itself; with only one, the
   workflow stops. Setting them up once is in `docs/self-hosting.md` (Releasing). Never replace the key pair: installed
   apps only accept updates signed with the key they were built with.

## Tag

```sh
git switch main && git pull --ff-only
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

`.github/workflows/release.yml` then publishes the DMG, the agents, the relay executables and Docker image, the install
scripts and `SHA256SUMS`.

## After

- The workflow is green and the release has every asset listed in the workflow, `appcast.xml` included.
- On a Mac running the previous version (one built with the update keys), Settings › General › **Check for Updates…**
  offers the new one and installs it.
- Install the DMG on a Mac and check that **Update agent** appears for a machine on the previous version.
- With a Developer ID, the widget is in the gallery (right-click the desktop › **Edit Widgets…**, search Tonton) once
  the new app has started, and it lists the sessions of the notch. Ad-hoc releases have no widget.
- If the relay changed, update the hosted relay with `install-relay.sh` (see `docs/self-hosting.md`).
