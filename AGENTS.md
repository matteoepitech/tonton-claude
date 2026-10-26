# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot…) and for the humans driving them. Read this
before changing anything; [README.md](README.md) and [docs/self-hosting.md](docs/self-hosting.md) explain the product
and the security model.

## The project in one minute

Tonton Claude shows the Claude Code sessions of all your machines in the notch of a Mac. Three parts talk through a
WebSocket relay, and everything that describes what Claude is doing is end-to-end encrypted:

```
claude ─ hooks + MCP channel ─▶ agent ──sealed blobs──▶ relay ──WebSocket──▶ macOS app (notch)
```

| Path | What | Language |
|---|---|---|
| `agent/` | One binary per machine: a background service, Claude Code hooks, an MCP channel that streams the transcript and relays prompts and permissions. Tray icons in `agent/tray/` (Swift on macOS, PowerShell on Windows). | TypeScript (Bun) |
| `relay/` | Accounts and machines in SQLite, live sessions in memory, WebSocket routing. Never sees plaintext. | TypeScript (Bun) |
| `shared/` | The wire protocol, the account token format and versions, used by the agent and the relay. | TypeScript |
| `app/` | The macOS app. `TontonCore` holds the testable logic (crypto, wire format, models, markdown), `TontonClaude` the SwiftUI views. | Swift 5.10, macOS 14+ |
| `raycast/` | A Raycast extension that lists the sessions and messages them through the app's AppleScript dictionary (`app/Resources/TontonClaude.sdef`). | TypeScript (React) |
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
swift format lint --strict --configuration .swift-format --recursive Sources Tests ../agent/tray/macos
swift build && swift test
./scripts/build-app.sh        # build/TontonClaude.app (--install copies it to /Applications and launches it)
```

CI (`.github/workflows/ci.yml`) runs `check`, `test` and the Swift lint, build and tests, plus syntax checks of the install
scripts and a build of the macOS tray. Run the ones for the parts you touched before saying you are done.

## Rules that are easy to break

**End-to-end encryption.** Conversations, prompts, images, permission prompts, machine names, project paths and status
texts are sealed (AES-256-GCM with the account key) before they leave a machine or the app. Never add a plaintext field
that says anything about what Claude is doing, and never send decrypted content anywhere, logs included. If the relay
needs a value to route or limit, it must be something it can see today (ids, states, sizes, timing).

**One protocol, two languages.** These pairs must change together, with tests on both sides:

| TypeScript | Swift |
|---|---|
| `shared/protocol.ts` | `app/Sources/TontonCore/Wire.swift`, `Entry.swift` |
| `agent/src/crypto.ts` | `app/Sources/TontonCore/E2E.swift` (same layout and additional data, `tonton/v1`) |
| `shared/account-token.ts` | `app/Sources/TontonCore/Account.swift` |

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
- No new dependency without a reason in the PR. The TypeScript side has two runtime dependencies; the app has none.

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
