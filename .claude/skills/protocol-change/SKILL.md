---
name: protocol-change
description: Add or change a message or a field exchanged between the agent, the relay and the macOS app (shared/protocol.ts and its Swift mirror). Use for any change to what travels over the WebSocket or the hook endpoint, including new sealed payloads.
---

# Changing the wire protocol

A message crosses three codebases in two languages, and the three never update at the same time. Go through every
step, even when a change looks local to one side.

## 1. Decide what the relay may see

- Anything about what Claude is doing (text, names, paths, tool calls, errors from the machine) is **sealed**: a
  plaintext interface in `shared/protocol.ts` (under "Plaintext payloads, sealed before leaving the machine"), sent as a
  `Sealed` string. Its Swift twin goes at the bottom of `app/Sources/TontonCore/Wire.swift`.
- Only ids, states, booleans, versions and sizes the relay needs for routing or limits may stay in clear.

## 2. Edit the protocol

- `shared/protocol.ts`: the message unions are `AgentMessage` (agent → relay), `RelayToAgent`, `HookPost`
  (`POST /api/hook`), `RelayToApp` and `AppMessage` (app → relay).
- New fields are **optional**. Never rename, retype or reuse a field: older agents, apps and relays are still out there.

## 3. Relay

- `relay/src/sockets.ts` dispatches socket messages, `relay/src/routes.ts` HTTP requests. Check every field with the
  helpers in `relay/src/validate.ts` (`isSealed`, `isText`…) before using it, and drop the message when a check fails.
- Anything kept in memory or in SQLite needs a cap in `relay/src/limits.ts`. Live session state is in
  `relay/src/sessions.ts`; schema changes are a new entry at the end of `MIGRATIONS` in `relay/src/registry.ts`.
- Unknown message types are already ignored: keep it that way.

## 4. Agent

- Socket messages go through `agent/src/channel/relay-connection.ts` and are built in `agent/src/channel/` (the session
  conversation is in `conversation.ts`); hook posts are in `agent/src/hook.ts`.
- Seal with `seal()` from `agent/src/crypto.ts`, open with `open()`.

## 5. App

- Decode in `app/Sources/TontonCore/Wire.swift`: `decodeIfPresent` for new fields, and a new `case` in the `switch` for a
  new message type (the `default` maps unknown types to `.unknown`, which is what an older app does with yours).
- Handle it in `app/Sources/TontonClaude/Data/SessionStore.swift`; messages to the relay are the `socket.send([...])`
  dictionaries there.
- Open sealed fields with `E2E` in `TontonCore`.

## 6. Check every mix of versions

Write down, in the PR, what happens for each:

| Relay | Agent | App |
|---|---|---|
| old | new | new |
| new | old | new |
| new | new | old |

If one of them breaks, either make it degrade gracefully (a missing field shows nothing, an action is greyed out) or
add a **Rollout** section saying which part must be updated first.

## 7. Test both languages

- `test/end-to-end.test.ts` runs a real relay and agent with a socket standing in for the app: add a case that goes
  through the new message.
- `relay/test/` for validation and limits, `agent/test/` for agent logic.
- `app/Tests/TontonCoreTests/`: decode a JSON sample written exactly as the relay sends it. For a new sealed payload,
  open a blob sealed by `agent/src/crypto.ts`, like `agentBlob` in `E2ETests.swift`.
- Then `bun run check && bun test`, and in `app/`: `swift format lint --strict --configuration .swift-format --recursive Sources Tests ../agent/tray/macos && swift test`.
