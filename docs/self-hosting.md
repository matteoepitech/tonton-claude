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
| `shared/` | The client core shared by the agent, the relay and the clients: wire protocol, AES-256-GCM sealing with WebCrypto, account token, session models. It runs in browsers. |
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
- **App updates.** The app reads the `appcast.xml` of the latest GitHub release with Sparkle. The feed and the disk image
  are signed with an EdDSA key whose public half is built into the app, and both are checked before anything is opened:
  a changed release file or a network in the middle can't install anything.
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
- When OpenCode is set up, adds `tonton-claude.js` to its plugins folder (`~/.config/opencode/plugins`). OpenCode loads it
  on its next start (`opencode service restart` with OpenCode 2), and its sessions show up next to Claude Code's.

`tonton status` checks the connection, `tonton uninstall` removes everything. From the Mac, Settings › Machines ›
**Diagnose** runs the same kind of checks on a machine and offers a **Repair** for each step of the install that is off:
the background service, the hooks, the MCP server, the launcher, the status line and the OpenCode plugin. A repair never
rewrites a `settings.json` that is not valid JSON, nor hooks the user turned off. The agent logs what it does to
`~/.tonton/tonton.log`, never what Claude writes: Settings › Machines › **Show agent log** reads its last 300 lines from the
Mac, sealed on the way, with the account key, the machine's credential, tokens and proxy passwords taken out.

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
| OpenCode (1 or 2) | ✅ | ✅ | ✅ |

On first launch, Claude Code asks you to confirm "I am using this for local development": channels are still a research preview.

## Behind a proxy

Machines on a company network often reach the internet through an HTTP proxy. The agent reads the same variables as curl:

| Variable | Meaning |
|---|---|
| `HTTPS_PROXY` | Proxy for a relay on `https://` (the hosted one), and for updates from GitHub. `http://user:password@proxy:3128` if it wants a password. |
| `HTTP_PROXY` | Proxy for a relay on `http://`, such as a self-hosted one on the local network. |
| `ALL_PROXY` | Used when the one above is not set. |
| `NO_PROXY` | Hosts that are reached directly, separated by commas: `relay.corp` (and its subdomains), `relay.corp:8443`, `10.0.0.0/8`, or `*`. |

Lower case names work too (`https_proxy`), and win over upper case ones. The proxy must be an HTTP or HTTPS proxy; SOCKS
proxies are not supported. Every connection of the agent goes through it: joining with the token, the WebSocket of the
background service and of each session, hooks, and updates from GitHub.

Set the variables before running the install line, in the same terminal:

```sh
export HTTPS_PROXY=http://proxy.corp:3128
curl -fsSL https://github.com/matteoepitech/tonton-claude/releases/latest/download/install.sh | TONTON_TOKEN='<token>' sh
```

- **macOS and Linux.** The background service does not start from a shell, so the installer writes the proxy variables it
  sees into the LaunchAgent or the systemd unit. After changing proxy, run the install line again. Sessions get the
  variables of the terminal claude starts from, so keep them in your shell profile.
- **Windows.** The service gets your user environment variables, not those of a PowerShell window: set them with
  `setx HTTPS_PROXY http://proxy.corp:3128`, then sign out and back in. Windows PowerShell does not read `HTTPS_PROXY`
  itself, so download the install script through the proxy:
  `$env:HTTPS_PROXY='http://proxy.corp:3128'; $env:TONTON_TOKEN='<token>'; irm -Proxy $env:HTTPS_PROXY https://github.com/matteoepitech/tonton-claude/releases/latest/download/install.ps1 | iex`

`tonton status` shows the proxy in use, without its password, and whether the relay answers through it.

The Mac app connects with the system settings of the Mac (System Settings › Network › Proxies), like Safari.

## The web app

`tonton-web.html` is the whole web app in one file, published with each release (`bun run web` builds it in `dist/`).
Open it from disk, or put it on any static host: it has no server side.

- It signs in with the account's recovery key (Settings › Relay in the Mac app). Its JSON holds the relay, the app's
  token and the end-to-end key. **Remember on this device** keeps the key in IndexedDB as a `CryptoKey` that cannot be
  exported, so no script can read it back.
- **Scan the QR code** reads the same key with the camera: Settings › Machines › Phone or browser shows it as a QR code,
  without the join secret, which the page does not use. The Mac shows it only when asked, for a minute at most, and
  hides it as soon as its window is left. The page decodes the frames itself with [jsQR](https://github.com/cozmo/jsQR),
  since Safari and Firefox have no `BarcodeDetector`: no frame leaves the page, and the camera stops once a code is read.
  Browsers give the camera to pages on https, on localhost or opened from a file.
- It decrypts and encrypts in the page with WebCrypto, like the Mac app with CryptoKit. The relay sees what it sees from
  the Mac app: ids, states, sizes and sealed blobs.
- Browsers cannot set the `Authorization` header of a WebSocket. The page opens `/ws/app` with the subprotocols
  `tonton` and `bearer.<token>`, and the relay answers with `tonton` only. Relays before 0.8.0 refuse it.
- Its Content-Security-Policy allows its own inline script and style, and WebSocket connections, nothing else. It never
  puts what a session says into the page as HTML.

### Read-only shares

A share lets a teammate follow one session from the web app, without the account key.

- The app asks the relay for a share (`POST /api/shares` with the session and a duration of 1 to 720 hours). The relay
  answers with an id and a `ts_…` token, keeps a hash of the token, and lists the share in `GET /api/shares`.
- The app makes a random key for the share and sends the session's agent a `ShareOrder` sealed with the account key:
  the share id, the session id, the share key and when it ends. The relay stores it and hands it to the agent each
  time the session connects. The agent drops an order for another session, a past one, or one that does not open with
  the account key.
- The agent then sends a second copy of the conversation, sealed with the share key, plus the project and the title.
  The relay keeps that copy in memory only (4 MB per share at most) and sends it to `/ws/share`, which opens with the
  share token (as a header, or as the subprotocol `bearer.<token>` next to `tonton`) and reads only.
- The share key is `tontonshare1.` followed by base64url JSON of the relay, the token and the key. Whoever holds it reads
  that session and nothing else. The relay sees the same as for the rest: ids, a status, sizes and sealed blobs.
- Revoking (`DELETE /api/shares/<id>`) or the end of the share closes the viewers' sockets and tells the agent to stop.
  The agent also stops at the end date by itself. The relay has to cooperate for a revocation before that date, as it
  does for signing out a machine.
- An account holds 10 shares at most, and a share 20 viewers. Sessions only on this Mac, read without the agent, cannot
  be shared: there is no agent to seal the copy.

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
| `TONTON_METRICS_TOKEN` | Optional: turns on `/metrics` for this bearer token (24+ characters). See [Monitoring](#monitoring). |

**Docker**: the image `ghcr.io/matteoepitech/tonton-claude-relay` is published with each release, for amd64 and arm64.
`docker compose up -d` with the `docker-compose.yml` of this repository; data is kept in the `tonton-data` volume. Add
[Watchtower](https://containrrr.dev/watchtower/) to follow new releases automatically. Note that Docker publishes ports
around `ufw`.

Then in the app: Settings › Relay › Self-hosted, enter your URL and create an account.

### Monitoring

`/health` answers `ok` while the relay runs, for uptime checks and container health checks.

`/metrics` gives counts in the Prometheus text format. It is off by default: set `TONTON_METRICS_TOKEN` and scrape it
with that token.

```yaml
scrape_configs:
  - job_name: tonton
    scheme: https
    static_configs:
      - targets: ['relay.example.com']
    authorization:
      credentials: <TONTON_METRICS_TOKEN>
```

| Metric | What |
|---|---|
| `tonton_relay_info{version}` | The relay's version |
| `tonton_relay_start_time_seconds` | When the relay started |
| `tonton_accounts`, `tonton_machines` | Accounts, and machines that joined one |
| `tonton_machines_online` | Machines with at least one connection |
| `tonton_sockets{role}` | Open WebSockets: `app` for Macs, `agent` for machine services and sessions |
| `tonton_sessions{status}` | Sessions the relay holds, by status (`working`, `idle`, `offline`…) |
| `tonton_history_entries`, `tonton_history_bytes` | The sealed history the relay holds |
| `tonton_ws_messages_received_total{role}`, `tonton_ws_messages_sent_total{role}` | WebSocket messages since the start |
| `tonton_ws_received_bytes_total{role}`, `tonton_ws_sent_bytes_total{role}` | Their size |

Every value is a total over the whole relay: nothing sealed, no id, nothing per account. Wrong tokens count as failed
attempts, like wrong account tokens, and the same per-IP limit applies.

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

Pushing a version tag publishes everything at that version: the app (DMG, and its update feed once the keys below are
set), the agents, their install scripts, the relay (executables, install script, Docker image) and a `SHA256SUMS`:

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

For the app to update itself, make a pair of update keys once with Sparkle's `generate_keys`, which `swift build` puts
in `app/.build/artifacts/sparkle/Sparkle/bin/`. It keeps the private key in your login keychain. Then add:

| Kind | Name | Value |
|---|---|---|
| Variable | `SPARKLE_PUBLIC_KEY` | The public key, printed by `generate_keys -p` |
| Secret | `SPARKLE_PRIVATE_KEY` | The content of the file written by `generate_keys -x private-key.txt` (delete the file afterwards) |

Each release then publishes an `appcast.xml` signed with the private key, and the app checks it once a day (Settings ›
General › Check for updates). Without the keys, the app never checks. Keep a copy of the private key somewhere safe:
installed apps only accept updates signed with it.
