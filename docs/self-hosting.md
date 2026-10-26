# Self-hosting and technical details

Everything you need to run your own relay, understand the security model or hack on Tonton Claude.

## How it works

```
[claude on Windows ×N] ──┐
[claude on a Mac]      ──┼── agent (service + hooks + channel) ──▶ relay ──WebSocket──▶ Tonton Claude.app (notch)
[claude on Linux]      ──┘             sealed blobs only            tonton.d3l.tech or your own
```

Like RustDesk, everything you install comes from the [GitHub releases](https://github.com/matteoepitech/tonton-claude/releases):
the app, the agents and the relay. The relay only relays: updating the app and the agents never requires touching it.

| Part | Role |
|---|---|
| `agent/` | One binary per machine. A background service keeps the machine reachable and shows a tray icon to change relay; Claude Code hooks report status; an MCP *channel* streams the transcript, injects messages from the notch and relays permission prompts. |
| `relay/` | The relay. Accounts, machines and the sealed history of sessions in SQLite, live sessions in memory with a memory budget, WebSocket routing. |
| `app/` | The macOS app living in the notch (SwiftUI), plus its settings window. |
| `scripts/` | Builds, and the install scripts published with each release. |

## Security model

- **Accounts.** Anyone can create an account on a relay from the app. One relay serves any number of people; each account only
  ever sees its own machines and sessions.
- **End-to-end encryption.** The app generates a 256-bit key on your Mac. Conversations, prompts, images, permission prompts,
  machine names, project paths and status texts are sealed with AES-256-GCM before they leave a machine. The relay stores and
  routes opaque blobs: whoever runs it cannot read them.
- **Account token.** Machines join with the account token shown in the app: the relay address, a join secret and the
  end-to-end key, like a RustDesk key. The relay keeps a hash of the secret. Regenerating the token replaces the secret and
  the key and signs every machine out.
- **Per-machine credentials.** Each machine that joins receives its own credential, revocable from the app. The relay stores
  SHA-256 hashes of credentials and secrets, never the secrets themselves.
- **No secret in URLs.** Install scripts are public and generic; the token travels in the `TONTON_TOKEN` variable of the
  command you paste. The key it holds is never sent to the relay.
- **Verified downloads.** Install scripts and updates check every file against the `SHA256SUMS` of its release.
- **Agent updates.** Only the app can ask a machine to update: the order is sealed with the account key and expires after
  10 minutes, so the relay can neither forge nor replay it. The agent downloads the release from GitHub, never from the
  relay, and checks the version it reports before swapping it in.
- **Abuse limits.** Per-IP rate limits on sign-ups, joins and failed authentications; caps on machines and sessions per account.

**While your Mac is away.** The relay keeps each session's sealed history, so the notch catches up when the Mac wakes
or reconnects: up to 800 entries and 16 MB per session, 128 MB per account, the oldest going first. Finished sessions
are dropped after 6 hours. The history is in memory and in the relay's database, so it survives a restart of the relay:
sessions come back offline until their agent reconnects. The database holds the same as the memory: ids, states, times
and sealed blobs.

What a relay can still see: that an account exists, how many machines and sessions it has, session states (working, waiting…)
and timing.

## What the installer changes on a machine

- Puts the agent in `~/.tonton/` (config readable by you only).
- Starts its background service at login: a `Run` entry on Windows, a LaunchAgent on macOS, a user systemd unit on Linux.
  The service keeps the machine online in the app, applies updates and shows the tray icon (Windows, macOS).
- Adds hooks to `~/.claude/settings.json` (a backup is kept next to it).
- Registers the `tonton` MCP server for Claude Code.
- Adds a `claude` launcher to your zsh, bash or PowerShell profile, which starts Claude Code with the Tonton Claude channel.

`tonton status` checks the connection, `tonton uninstall` removes everything.

**Changing relay or account.** Click the tray icon › **Set token…** and paste the token from the app, or run
`tonton token <token>`.

Running sessions switch on their next start. On Linux servers without a desktop there is no tray: use the command. A user
service only runs while you are logged in, unless you enable lingering: `loginctl enable-linger $USER`.

Updates from the app replace the binaries in `~/.tonton/bin` and run the install step again. Sessions already running keep
the previous agent until claude restarts.

| How claude is started | Status and conversation | Messages from the notch | Permissions from the notch |
|---|---|---|---|
| `claude` in a terminal (launcher installed) | ✅ | ✅ | ✅ |
| Any other way (IDE, script, cmd.exe…) | ✅ | read only | — |

On first launch, Claude Code asks you to confirm "I am using this for local development": channels are still a research preview.

## Running your own relay

The relay is a single executable behind any HTTPS reverse proxy with WebSocket support. It only needs updating when its own
code changes: new versions of the app and the agents work with it.

**systemd**, on a Linux server (x64 or arm64). Run the same line again to update:

```sh
curl -fsSL https://github.com/matteoepitech/tonton-claude/releases/latest/download/install-relay.sh | sudo sh
```

It installs `/usr/local/bin/tonton-relay` and `tonton.service`, which runs as an unprivileged user with a strict systemd
sandbox; data goes to `/var/lib/tonton`. Configuration lives in `/etc/tonton/tonton.env`:

| Variable | Meaning |
|---|---|
| `PORT` | Port the reverse proxy targets, 7777 by default |
| `TONTON_REGISTRATION` | `open` (anyone can create an account) or `closed` |
| `TONTON_ADMIN_TOKEN` | With `closed`, the bearer token allowed to create accounts (24+ characters) |
| `TONTON_TRUST_PROXY` | `1` to read the client IP from `X-Forwarded-For`. Only behind a reverse proxy that sets it. |
| `TONTON_REGION` | Optional: where the relay runs (e.g. `Paris`), shown in the app next to the latency. On Fly.io, `FLY_REGION` is used. |

**Docker**: the image `ghcr.io/matteoepitech/tonton-claude-relay` is published with each release, for amd64 and arm64.
`docker compose up -d` with the `docker-compose.yml` of this repository; data is kept in the `tonton-data` volume. Add
[Watchtower](https://containrrr.dev/watchtower/) to follow new releases automatically. Note that Docker publishes ports
around `ufw`.

Then in the app: Settings › Relay › Self-hosted, enter your URL and create an account.

## Building from source

```sh
bun install
bun run relay                  # relay on :7777, data in ./data
bun run build                  # agents and relay executables in dist/ (bun run build windows: one target)
bun run check                  # Biome (format + lint) and the TypeScript compiler
bun test                       # unit tests and the end-to-end test
cd app && swift test           # TontonCore tests (crypto, wire format, models)
cd app && ./scripts/build-app.sh --install    # the macOS app
```

`TONTON_HOME` runs an agent with an isolated config directory, and `TONTON_SERVICE=off` keeps it away from your login items.
The macOS tray icon is a separate Swift program: `swiftc -O agent/tray/macos/main.swift -o ~/.tonton/bin/tonton-tray`.

## Releasing

Pushing a version tag publishes everything at that version: the app (DMG), the agents, their install scripts, the relay
(executables, install script, Docker image) and a `SHA256SUMS`:

```sh
git tag -s v0.4.0 -m "v0.4.0"
git push origin v0.4.0
```

Once the new app is installed, it offers its version to every machine: one click on **Update agent** in the notch or in
Settings › Machines. The first time, the Docker image is private on GitHub: make it public in the package settings.

Locally, `app/scripts/build-app.sh --universal && app/scripts/make-dmg.sh` produces the same image in `app/build/`.

Without further setup the app is ad-hoc signed, and macOS asks users to confirm the first launch. To sign it with a
Developer ID and notarize it, add these repository secrets:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE` | Developer ID Application certificate exported as .p12, base64-encoded |
| `MACOS_CERTIFICATE_PASSWORD` | Password of the .p12 |
| `CODESIGN_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | Apple account, team and app-specific password used by `notarytool` |
