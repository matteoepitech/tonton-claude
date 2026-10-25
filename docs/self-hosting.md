# Self-hosting and technical details

Everything you need to run your own relay, understand the security model or hack on Tonton Claude.

## How it works

```
[claude on Windows ×N] ──┐
[claude on a Mac]      ──┼── agent (hooks + channel) ──▶ relay ──WebSocket──▶ Tonton Claude.app (notch)
[claude on Linux]      ──┘        sealed blobs only        tonton.d3l.tech or your own
```

| Part | Role |
|---|---|
| `agent/` | One binary per machine. Claude Code hooks report status; an MCP *channel* streams the transcript, injects messages from the notch and relays permission prompts. |
| `relay/` | The relay (Bun). Accounts and machines in SQLite, live sessions in memory with a memory budget, WebSocket routing, install scripts and agent binaries. |
| `app/` | The macOS app living in the notch (SwiftUI), plus its settings window. |
| `deploy/` | systemd unit and deploy script for a self-hosted relay. |

## Security model

- **Accounts.** Anyone can create an account on a relay from the app. One relay serves any number of people; each account only
  ever sees its own machines and sessions.
- **End-to-end encryption.** The app generates a 256-bit key on your Mac. Conversations, prompts, images, permission prompts,
  machine names, project paths and status texts are sealed with AES-256-GCM before they leave a machine. The relay stores and
  routes opaque blobs: whoever runs it cannot read them.
- **Per-machine credentials.** A machine joins with a single-use enrollment code that expires after 15 minutes and receives
  its own token, revocable from the app. The relay stores SHA-256 hashes of tokens and codes, never the secrets.
- **No secret in URLs.** Install scripts are public and generic; the code and the key travel in the `TONTON_ENROLL` variable
  of the command you paste. The key itself is never sent to the relay.
- **Agent updates.** Only the app can ask a machine to update: the order is sealed with the account key and expires after
  10 minutes, so the relay can neither forge nor replay it. The agent downloads its new build from the relay, as the install
  script does, and checks the version it reports before swapping it in.
- **Abuse limits.** Per-IP rate limits on sign-ups, enrollment and failed authentications; caps on machines and sessions per account.

What a relay can still see: that an account exists, how many machines and sessions it has, session states (working, waiting…)
and timing.

## What the installer changes on a machine

- Puts the agent in `~/.tonton/` (config readable by you only).
- Adds hooks to `~/.claude/settings.json` (a backup is kept next to it).
- Registers the `tonton` MCP server for Claude Code.
- Adds a `claude` launcher to your zsh, bash or PowerShell profile, which starts Claude Code with the Tonton Claude channel.

`tonton status` checks the connection, `tonton uninstall` removes everything.

Updates from the app replace the binary in `~/.tonton/bin` and run the install step again. Sessions already running keep the
previous agent until claude restarts.

| How claude is started | Status and conversation | Messages from the notch | Permissions from the notch |
|---|---|---|---|
| `claude` in a terminal (launcher installed) | ✅ | ✅ | ✅ |
| Any other way (IDE, script, cmd.exe…) | ✅ | read only | — |

On first launch, Claude Code asks you to confirm "I am using this for local development": channels are still a research preview.

## Running your own relay

The relay is a single Bun process behind any HTTPS reverse proxy with WebSocket support.

**systemd (recommended)**, on a Debian/Ubuntu host with Bun in `/opt/bun`:

```sh
deploy/deploy.sh root@your-host     # syncs to /opt/tonton, builds the agents, installs and restarts tonton.service
```

To keep your host and SSH options out of the repository, copy `deploy/deploy.env.example` to `deploy/deploy.env`
(git-ignored) and run `deploy/deploy.sh` without arguments.

Configuration lives in `/etc/tonton/tonton.env`:

| Variable | Meaning |
|---|---|
| `PUBLIC_URL` | Public HTTPS address, used in install scripts |
| `TONTON_REGISTRATION` | `open` (anyone can create an account) or `closed` |
| `TONTON_ADMIN_TOKEN` | With `closed`, the bearer token allowed to create accounts (24+ characters) |
| `TONTON_TRUST_PROXY` | `1` to read the client IP from `X-Forwarded-For`. Only behind a reverse proxy that sets it. |

The unit runs as an unprivileged user with a strict systemd sandbox; data goes to `/var/lib/tonton`.

**Docker**: `PUBLIC_URL=https://relay.example.com docker compose up -d`. Data is kept in `./data`.
Note that Docker publishes ports around `ufw`.

Then in the app: Settings › Relay › Self-hosted, enter your URL and create an account.

## Building from source

```sh
bun install
bun run relay                  # relay on :7777, data in ./data
bun run build:agent            # agent binaries in dist/
bun run check                  # Biome (format + lint) and the TypeScript compiler
bun test                       # unit tests and the end-to-end test
cd app && swift test           # TontonCore tests (crypto, wire format, models)
cd app && ./scripts/build-app.sh --install    # the macOS app
```

`TONTON_HOME` runs an agent with an isolated config directory.

## Releasing

Pushing a version tag builds the macOS app for Apple silicon and Intel and publishes a GitHub release with the DMG:

```sh
git tag -s v0.3.0 -m "v0.3.0"
git push origin v0.3.0
```

The version shown in the app comes from the tag. The agent has its own version in `shared/version.ts`: bump it when the agent
changes and redeploy the relay, which builds and serves the agents. Machines then offer the update in the app.

Locally, `app/scripts/build-app.sh --universal && app/scripts/make-dmg.sh` produces the same image in `app/build/`.

Without further setup the app is ad-hoc signed, and macOS asks users to confirm the first launch. To sign it with a
Developer ID and notarize it, add these repository secrets:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE` | Developer ID Application certificate exported as .p12, base64-encoded |
| `MACOS_CERTIFICATE_PASSWORD` | Password of the .p12 |
| `CODESIGN_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | Apple account, team and app-specific password used by `notarytool` |
