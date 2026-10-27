# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot…) and for the humans driving them. Read this
before changing anything; [README.md](README.md) and [docs/self-hosting.md](docs/self-hosting.md) explain the product
and the security model.

## The project in one minute

Tonton Claude shows the Claude Code sessions of all your machines in the notch of a Mac. Three parts talk through a
WebSocket relay, and everything that describes what Claude is doing is end-to-end encrypted:

```
claude ─ hooks + MCP channel ─▶ agent ──sealed blobs──▶ relay ──WebSocket──▶ macOS app (notch)
opencode ─ Tonton plugin ──────▶ agent
```

| Path | What | Language |
|---|---|---|
| `agent/` | One binary per machine: a background service, Claude Code hooks, an MCP channel that streams the transcript and relays prompts and permissions. Tray icons in `agent/tray/` (Swift on macOS, PowerShell on Windows). | TypeScript (Bun) |
| `relay/` | Accounts, machines and sealed session history in SQLite, live sessions in memory, WebSocket routing. Never sees plaintext. | TypeScript (Bun) |
| `shared/` | The client core: wire protocol, end-to-end crypto, account token, session models and a relay client. Used by the agent, the relay and the client apps, and runs in browsers. Versions, for the agent and the relay. | TypeScript |
| `app/` | The macOS app. `TontonCore` holds the testable logic (crypto, wire format, models, markdown) and also builds for iOS, `TontonMac` what reads this Mac's own files (local Claude Code and OpenCode sessions, the local agent), `TontonClaude` the SwiftUI views. | Swift 5.10, macOS 14+ |
| `ios/` | The iPhone app (`TontonClaude.xcodeproj`, Xcode 16 or later), its Live Activity (`TontonWidgets`) and the extension that opens permission alerts (`TontonNotifications`), on `TontonCore`. | Swift 5, iOS 17+ |
| `raycast/` | A Raycast extension that lists the sessions and messages them through the app's AppleScript dictionary (`app/Resources/TontonClaude.sdef`). | TypeScript (React) |
| `web/` | The web app: one HTML file (`bun run web`, released as `tonton-web.html`) built on the client core in `shared/`, which decrypts in the browser. | TypeScript |
| `desktop/` | The island for Windows and Linux: an Electron window at the top of the screen with the web app's views (`web/views.ts`), a tray icon, and the account in the system's keyring. Its own `package.json`. | TypeScript (Electron) |
| `scripts/` | Release builds and the install scripts published with each release (`install.sh`, `install.ps1`, `install-relay.sh`). | TS, sh, PowerShell |
| `test/` | Tests that run a real relay with a real agent. Unit tests live next to each part (`agent/test`, `relay/test`, `app/Tests`). | TypeScript |

## Commands

```sh
bun install
bun run check                 # Biome (format + lint) and tsc: must be clean
bun run format                # applies Biome's fixes
bun test                      # all TypeScript tests, including test/end-to-end.test.ts
bun run relay                 # a relay on :7777 with its data in ./data

cd app
swift format lint --strict --configuration .swift-format --recursive Sources Tests ../agent/tray/macos ../ios
swift build && swift test
./scripts/build-app.sh        # build/TontonClaude.app (--install copies it to /Applications and launches it)

cd ios                        # the iPhone app, for the Simulator, unsigned
xcodebuild -project TontonClaude.xcodeproj -scheme TontonClaude -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build

cd desktop
bun install && bun run check  # Electron and electron-builder, then tsc
bun run start                 # the island from source; TONTON_ISLAND_HOME=<temp dir> keeps its account apart
bun run package:windows       # out/TontonClaude-Setup-<version>.exe, unsigned (builds from macOS and Linux too)
bun run package:linux         # out/TontonClaude-<version>-x86_64.AppImage and -amd64.deb, unsigned
```

The iOS project uses folders Xcode keeps in sync: a new `.swift` file in `ios/TontonClaude`, `TontonWidgets`,
`TontonNotifications`, `Shared` or `SharedUI` is built without touching `project.pbxproj`.

CI (`.github/workflows/ci.yml`) runs `check`, `test` and the Swift lint, build and tests, plus syntax checks of the install
scripts, a build of the macOS tray, a Simulator build of the iPhone app, and the island on Windows and Linux runners: runs
against a relay (`desktop/test/smoke`: on Windows, X11, and GNOME's compositor on Wayland) and its packages. Run the
ones for the parts you touched before saying you are done.

## Rules that are easy to break

**End-to-end encryption.** Conversations, prompts, images, permission prompts, machine names, project paths and status
texts are sealed (AES-256-GCM with the account key) before they leave a machine or the app. Never add a plaintext field
that says anything about what Claude is doing, and never send decrypted content anywhere, logs included. If the relay
needs a value to route or limit, it must be something it can see today (ids, states, sizes, timing).

**One protocol, two languages.** These pairs must change together, with tests on both sides:

| TypeScript | Swift |
|---|---|
| `shared/protocol.ts`, `shared/wire.ts` | `app/Sources/TontonCore/Wire.swift`, `Entry.swift` |
| `shared/crypto.ts` | `app/Sources/TontonCore/E2E.swift` (same layout and additional data, `tonton/v1`) |
| `shared/account-token.ts` | `app/Sources/TontonCore/Account.swift` |
| `shared/session.ts`, `shared/vault.ts`, `shared/payloads.ts` | `app/Sources/TontonCore/Session.swift`, `SessionVault.swift` |
| `IslandState`, `PermissionPush`, `PushDevice` in `shared/protocol.ts`; `islandState` in `relay/src/push.ts` | `app/Sources/TontonCore/Island.swift`, `Push.swift` (the iPhone's Live Activity and alerts) |

`shared/test/swift-vectors.json` holds blobs and relay messages made by the Swift side, with what it reads from them; both
test suites check it. After a change to what either side seals or reads, write it again with
`TONTON_WRITE_VECTORS=1 swift test --filter VectorTests` in `app/`.

**The client core runs in browsers.** Everything `shared/index.ts` exports uses WebCrypto and web APIs only, no Node or
Bun ones: `bun run check` type-checks it against the DOM types alone (`shared/tsconfig.json`).

**Versions mix in the wild.** The relay is only updated when its own code changes, and machines can run an agent older
than the app until someone clicks **Update agent**. So a new app or agent must work with the deployed relay, and the
app must cope with older agents: add optional fields, ignore unknown ones, never rename or repurpose a field. If a change
really needs a new relay, say so in the PR.

**Relay data.** Schema changes are a new entry at the end of `MIGRATIONS` in `relay/src/registry.ts`; never edit an
existing one. Every input from a socket or a request goes through `relay/src/validate.ts`, and every new store gets a cap
in `relay/src/limits.ts`.

**Claude Code is a moving target.** Transcripts (`agent/src/transcript/parser.ts`) are not a public format: skip what you
don't recognize, never throw. Channels are a research preview started with `--dangerously-load-development-channels`
(see `agent/src/install/shell-profile.ts`).

**Claude Code and OpenCode.** Tonton shows the sessions of both, and every feature works with both. Claude Code goes
through hooks, the MCP channel and its transcripts (`agent/src/channel`, `agent/src/transcript`); OpenCode through
Tonton's plugin and the `tonton opencode` bridge (`agent/src/opencode`), whose events are no more public than the
transcripts: skip what you don't recognize, never throw. A change for one tool comes with the same change for the other,
tested on both sides. When it really cannot work for one (Claude plan limits do not exist in OpenCode), say why in the PR.

**Three platforms.** The agent runs on Windows, macOS and Linux: use `node:path`, no POSIX-only shell calls, and keep
`scripts/install.sh` and `scripts/install.ps1` in step.

**Don't touch the developer's own setup.** `tonton install` edits the real `~/.claude/settings.json`, shell profiles and
login items. Run agents with `TONTON_HOME=<temp dir>` and `TONTON_SERVICE=off`, as the tests do, and don't run the
installer or the uninstaller on the developer's machine unless asked.

**Releases** come from a signed `v*` tag pushed by the maintainer. Don't tag, publish a release or touch the
repository's secrets.

## Style

- Match the code around you: names, comment density, idioms. Files open with a short comment saying what they are for;
  comments explain why, not what.
- TypeScript: Biome settings in `biome.json` (2 spaces, single quotes, no semicolons, 140 columns). Strict `tsc`, no
  non-null assertions.
- Swift: `app/.swift-format` (4 spaces, 140 columns, no force `try`). CI lints with `--strict`. Logic that can be tested
  goes in `TontonCore`; views stay thin.
- Writing (docs, UI strings, PRs): plain, short English sentences. User-facing names follow the app: Settings › Machines,
  **Update agent**, the notch.
- No new dependency without a reason in the PR. The agent has two runtime dependencies and the web app bundles one, jsQR,
  its QR scanner. The app has one, Sparkle, for its own updates, and `TontonCore` has none. The island in `desktop/` has
  Electron, and electron-builder to package it, in its own `package.json`.

## Tests

- Bug fix: add a test that fails without it. New behavior: test it where it lives (`TontonCore`, `agent/test`,
  `relay/test`), and in `test/` when it crosses the relay.
- Tests that wait on sockets or files poll until the condition holds (the `eventually` helper in
  `test/service.test.ts`); never assert right after an asynchronous event.
- SwiftUI views can't be checked in CI. Render them to an image (see the `check-swiftui-view` skill) and say in the PR
  what you did not see on screen.

## Commits and pull requests

- Conventional commits, lower case, imperative, with the part as scope when there is one: `feat(app): …`,
  `fix(agent): …`, `test: …`, `docs: …`.
- One topic per PR. The description says what changes and why, how it was tested, what was not checked, and a
  **Rollout** section when the relay or the agents need updating.

## Skills

Step-by-step guides for recurring tasks live in `.claude/skills/`. Claude Code loads them on its own; other agents can
read them as plain Markdown.

| Skill | When |
|---|---|
| [`protocol-change`](.claude/skills/protocol-change/SKILL.md) | Adding or changing a message or field between the agent, the relay and the app |
| [`local-stack`](.claude/skills/local-stack/SKILL.md) | Running a relay, an agent and the app on one machine without touching the real setup |
| [`check-swiftui-view`](.claude/skills/check-swiftui-view/SKILL.md) | Seeing what a SwiftUI view looks like without launching the app |
| [`release`](.claude/skills/release/SKILL.md) | Maintainer only: cutting a version |
