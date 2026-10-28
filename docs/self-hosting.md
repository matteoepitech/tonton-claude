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
| `web/` | The website (`web/site/`, React), served by the relay at its address and released as one HTML file. The island's views are in `web/views.ts`. |
| `desktop/` | The island for Windows and Linux: an Electron window at the top of the screen, a tray icon, the account in the system's keyring. |
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
- **Widget.** The app writes what the widget shows, each session's project, machine and state, to a file in the app group
  container it shares with the widget, readable by you only. Conversations, prompts, status texts and folders never go
  there, and the file is emptied when the app quits. From macOS 15, other apps need your permission to open that
  container.
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

The web app is React, with [shadcn/ui](https://ui.shadcn.com)'s components on Radix, Tailwind, and
[React Flow](https://reactflow.dev) for the pools' graph (`web/site/`). Bun bundles it with Tailwind's plugin
(`scripts/site-build.ts`). `tonton-web.html` is the whole web app in one file, published with each release (`bun run web`
builds it in `dist/`). Open it from disk, or put it on any static host: it has no server side.

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
  puts what a session says into the page as HTML: React renders text, and Claude's Markdown is built as DOM nodes
  (`web/markdown.ts`).

### At the relay's address

From 0.8.0 the relay also serves the web app at its own address, `https://<relay>/`: a browser needs nothing else.
`scripts/build.ts` bundles `web/site.html`, with its script and style, into the relay's executable; `bun run relay`
builds them at the first visit.

- Every file goes out with a Content-Security-Policy that runs the page's own script and style only, from the relay,
  with nothing inline. The page opens sockets to that relay only, and no other site can show it in a frame.
- The page gets a nonce of its own at each visit, in its policy (`style-src 'self' 'nonce-…'`) and in a meta tag: the
  `<style>` tags its components add while it runs (Radix locking the page's scroll under a dialog) carry it. It allows
  styles only, never a script.
- The script and style have a hash in their names and are cached for good; the page itself is asked for again at each
  visit, so an updated relay serves its new version.
- Here the page also has a **Pools** tab ([pools.md](pools.md)): pools take the relay's routes, which only a page from
  the relay itself may call. `tonton-web.html` opened from disk shows the sessions and points to the relay for pools.
- The key stays in the browser, as with `tonton-web.html`. But here the page's code comes from the relay: whoever runs
  the relay could serve a page that reads the key when you paste it. On your own relay that is you. On a relay you don't
  run, `tonton-web.html` from the release keeps its code away from the relay.

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

## The iPhone app

`ios/` is a native iPhone app (iOS 17 or later) built on `TontonCore`, the Mac app's Swift package: the same models,
crypto and relay client.

- It signs in to the account of the Mac with its recovery key, scanned in the app from the QR code of **Settings ›
  Machines › Phone or browser** (VisionKit reads it on the phone) or pasted. The phone keeps the account in its
  Keychain, on this device only.
- While it is open, it reads the relay's socket like the Mac app: the sessions, their conversation, messages, permission
  requests, `/compact` and `/clear`.
- **Live Activity.** The sessions that need you, then those at work, on the Lock Screen and in the Dynamic Island. Its
  state is ids, states and the agents' sealed blobs (`IslandState` in `shared/protocol.ts`); the widget opens them with
  the key the app shares with it through an app group.
- **Push notifications**, from a relay that holds an APNs key (below):
  - a permission request is an alert whose text is the same for every request ("A Claude Code session is waiting for
    your approval"), with the sealed request and the sealed session next to it. The app's notification service
    extension opens them on the phone and writes the real text: the project, the machine, the tool and its command.
  - the alert has **Allow** and **Deny**, on the Lock Screen and on an Apple Watch it is mirrored to, which hands the tap
    back to the iPhone app. The app, woken in the background, connects to the relay, checks the request still waits,
    sends the verdict like the Mac does and waits for the relay to drop the request. When it cannot, an alert says so.
    Allowing asks for the phone or the watch to be unlocked; alerts of requests answered elsewhere are removed once the
    app hears of it. There is no watch app: the watch shows what the phone's notification extension wrote.
  - the Live Activity is pushed while the app is closed: at most every 10 seconds, at once when a session starts
    needing you. The relay ends it once nothing has run for 15 minutes, and starts the next one (iOS 17.2 and later)
    when a session starts working again.
  - Apple sees the device and Live Activity tokens, ids, states, timing and sealed blobs, like the relay.
- The phone registers its tokens with `POST /api/push/devices` (at most 10 phones per account, kept in the relay's
  database) and removes them when it signs out. While its socket is open, the relay leaves the Live Activity to the app.
- A relay without an APNs key answers `{ "enabled": false }` and keeps nothing; older relays answer 404. The app then
  works while it is open, and its Live Activity says it may be out of date after 15 minutes.

## The island for Windows and Linux

Each release publishes the island for Windows (`TontonClaude-Setup-<version>.exe`) and for Linux
(`TontonClaude-<version>-x86_64.AppImage` and `TontonClaude-<version>-amd64.deb`). It puts the sessions in a small island
at the top of the screen, above other windows: a bar that says what the sessions do, which opens on their list, a
conversation and its permission requests. It is the web app's views in an Electron window (`desktop/`), with a tray icon.

- **Signing in.** Paste the recovery key of an account (Settings › Relay in the Mac app), or create an account on the
  hosted relay or on yours: the island then makes the end-to-end key itself, and its menu (the tray icon, or ⋯ in the
  island) copies the install command for machines and the recovery key. No Mac needed.
- **Where the account is kept.** With **Remember on this computer**, the recovery key is encrypted by the system's keyring
  (Electron's `safeStorage`: DPAPI on Windows, the Secret Service of GNOME or KWallet on Linux) in the app's data folder
  (`%APPDATA%\Tonton Claude\account`, `~/.config/Tonton Claude/account`). Without a keyring, or unticked, nothing is
  written and the island forgets the account when it quits.
- **The token stays out of the page.** The main process adds the account's token to the page's socket as an
  `Authorization` header, so it works with every relay, and refuses sockets to anything else. The page gets the relay's
  address and the end-to-end key, imports the key as a `CryptoKey` it cannot read back, and decrypts like the web app.
- **The page** has the web app's Content-Security-Policy, runs sandboxed without Node, never navigates, and opens links
  in the browser. It asks for no permission (camera, notifications…).
- **Start at login** is in the menu, off by default: the Run key on Windows, `~/.config/autostart` on Linux.

On Linux:

- **GNOME and KDE on Wayland** let no app place its window or keep it above the others. The island starts itself again
  through XWayland, which both run, and is an X11 window there: at the top center of the screen, above the other
  windows, out of the taskbar and the window switcher. Where there is no XWayland, or with `TONTON_ISLAND_WAYLAND=1`, it
  is a plain Wayland window that the compositor places. X11 sessions need nothing.
- **The tray icon** is a StatusNotifierItem: KDE shows it, and GNOME with the AppIndicator extension (on by default in
  Ubuntu). Its menu shows and hides the island. Without it, the island's ⋯ button has the same menu, and opening the app
  again shows a hidden island.
- **Ubuntu 24.04 and later** only let installed apps with an AppArmor profile use the sandbox Chromium needs: take the
  `.deb`, which installs one. The AppImage there needs `--no-sandbox`, or the system setting
  `kernel.apparmor_restrict_unprivileged_userns=0`.

The packages are not signed: Windows SmartScreen warns about the installer until the project has a code-signing
certificate.

## Pools

Pools let the sessions of several people work on one project together, with an orchestrator Claude that hands out the work.
They are being built: [pools.md](pools.md) is the design, with the keys, what the relay sees and the threats.

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
| `TONTON_APNS_KEY_ID`, `TONTON_APNS_TEAM_ID`, `TONTON_APNS_KEY` or `TONTON_APNS_KEY_FILE`, `TONTON_APNS_TOPIC` | Optional: push notifications to the iPhone app. See [Pushes to the iPhone](#pushes-to-the-iphone). |

**Docker**: the image `ghcr.io/matteoepitech/tonton-claude-relay` is published with each release, for amd64 and arm64.
`docker compose up -d` with the `docker-compose.yml` of this repository; data is kept in the `tonton-data` volume. Add
[Watchtower](https://containrrr.dev/watchtower/) to follow new releases automatically. Note that Docker publishes ports
around `ufw`.

Then in the app: Settings › Relay › Self-hosted, enter your URL and create an account.

### Pushes to the iPhone

Off by default. Apple only accepts pushes signed with a key of the team that publishes the app, so a relay can push to
the iPhone app published from this repository only with the maintainer's key, and to an app you build and sign yourself
with your own.

| Variable | Value |
|---|---|
| `TONTON_APNS_KEY_ID` | The key's 10-character id (Certificates, Identifiers & Profiles › Keys, with Apple Push Notifications service) |
| `TONTON_APNS_TEAM_ID` | The team's 10-character id |
| `TONTON_APNS_KEY_FILE` | Path to the `AuthKey_<id>.p8` file. Or `TONTON_APNS_KEY`: its content, line breaks written `\n`, which suits `/etc/tonton/tonton.env` since the service cannot read files outside its data directory |
| `TONTON_APNS_TOPIC` | The app's bundle id, `tech.d3l.tontonclaude.ios` by default |

The relay refuses to start with only some of them. It uses Apple's sandbox for development builds and production for
TestFlight and the App Store, as each phone says when it registers. It never logs a token or a payload, and forgets the
tokens Apple says are no longer valid.

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
open ios/TontonClaude.xcodeproj                # the iPhone app: pick your team in Signing & Capabilities, then Run
cd desktop && bun install && bun run start    # the island (TONTON_ISLAND_HOME=<dir> keeps its account apart)
cd desktop && bun run package:windows         # its installer in desktop/out/, from any OS
cd desktop && bun run package:linux           # its AppImage and .deb in desktop/out/
```

The iPhone app also builds without signing, for the Simulator:
`xcodebuild -project ios/TontonClaude.xcodeproj -scheme TontonClaude -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`.
A build without an app group keeps the account in the app's own Keychain: it works, but the Live Activity and the
notifications show placeholders instead of the sessions' names.

`TONTON_HOME` runs an agent with an isolated config directory, and `TONTON_SERVICE=off` keeps it away from your login items.
The macOS tray icon is a separate Swift program: `swiftc -O agent/tray/macos/main.swift -o ~/.tonton/bin/tonton-tray`.

## Releasing

Pushing a version tag publishes everything at that version: the app (DMG, and its update feed once the keys below are
set), the island for Windows (installer) and Linux (AppImage, .deb), the agents, their install scripts, the relay
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

The desktop and Notification Center widget also needs the Developer ID. It reads the sessions from an app group
container the app writes to, and from macOS 15 a group is shared without asking the user only when its name starts with
the Team ID of the signature. So `build-app.sh` names it `<TeamID>.tech.d3l.tontonclaude` and embeds the widget only
then: no provisioning profile is needed for a group named that way.

| | Ad-hoc signature (no secrets) | Developer ID |
|---|---|---|
| The app, Sparkle updates | Yes. macOS asks to confirm the first launch. | Yes, notarized. |
| Widget | Left out. Without a Team ID, macOS 15 would ask at every launch of the app, and the widget can't ask, so it would read nothing. | Embedded, sandboxed, with the app group. |

`APP_GROUP=<any name> app/scripts/build-app.sh` embeds the widget in an ad-hoc build anyway, to check the bundle or try
it on macOS 14, which doesn't guard group containers. On macOS 15 and later the app then asks for access at every launch
and the widget stays empty.

For the app to update itself, make a pair of update keys once with Sparkle's `generate_keys`, which `swift build` puts
in `app/.build/artifacts/sparkle/Sparkle/bin/`. It keeps the private key in your login keychain. Then add:

| Kind | Name | Value |
|---|---|---|
| Variable | `SPARKLE_PUBLIC_KEY` | The public key, printed by `generate_keys -p` |
| Secret | `SPARKLE_PRIVATE_KEY` | The content of the file written by `generate_keys -x private-key.txt` (delete the file afterwards) |

Each release then publishes an `appcast.xml` signed with the private key, and the app checks it once a day (Settings ›
General › Check for updates). Without the keys, the app never checks. Keep a copy of the private key somewhere safe:
installed apps only accept updates signed with it.
