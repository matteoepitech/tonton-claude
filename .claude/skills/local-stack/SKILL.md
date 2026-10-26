---
name: local-stack
description: Run a relay, an agent and the macOS app together on one machine, isolated from the developer's real Tonton Claude and Claude Code setup. Use to reproduce a bug or try a change across components by hand.
---

# Running the whole stack locally

Most changes are covered faster by `bun test`: `test/end-to-end.test.ts` already starts a real relay, a real agent
channel and hook, a stand-in for Claude Code and a socket playing the app. Reach for the manual setup below only when
you need the real app or a real `claude`.

Keep everything in a temporary directory. **Never** run `tonton install` or `tonton uninstall` here: the installer edits
the real `~/.claude/settings.json`, shell profiles and login items.

## 1. Relay

```sh
export TONTON_DEV=$(mktemp -d)
PORT=7777 TONTON_DATA_DIR=$TONTON_DEV/relay bun run relay
```

Accounts are open by default.

## 2. Account and token

The app creates both (Settings › Relay, then Settings › Machines). Without the app:

```sh
ACCOUNT=$(curl -s -X POST http://127.0.0.1:7777/api/accounts)     # { accountId, token }
TOKEN=$(ACCOUNT="$ACCOUNT" bun -e '
import { encodeAccountToken } from "./shared/account-token"
const relay = "http://127.0.0.1:7777"
const { accountId, token } = JSON.parse(process.env.ACCOUNT)
const response = await fetch(`${relay}/api/account/token`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ regenerate: false }),
})
const { secret } = await response.json()
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
console.log(encodeAccountToken({ relay, account: accountId, secret, key }))')
```

The key is random, so only this agent can read what it seals: to see its sessions in the app, use the token the app
shows instead.

## 3. Agent

Always with an isolated home and without the login item:

```sh
export TONTON_HOME=$TONTON_DEV/agent TONTON_SERVICE=off
bun agent/src/main.ts token "$TOKEN"      # joins the relay
bun agent/src/main.ts service             # keeps the machine online (Ctrl+C to stop)
bun agent/src/main.ts status
```

`status` warns that the launcher and the service are missing: expected, since nothing was installed.

To drive a real `claude` from the notch, it has to be started with the channel and the hooks pointing at this agent,
which is what the installer sets up. Ask the developer before doing that on their machine.

## 4. App

```sh
cd app && ./scripts/build-app.sh && open build/TontonClaude.app
```

It shares its settings and account with an installed Tonton Claude: tell the developer before you point it to the local
relay (Settings › Relay › Self-hosted, `http://127.0.0.1:7777`), since that replaces their current account in the app.

## Clean up

Stop the relay and the service, then `rm -rf "$TONTON_DEV"`.
