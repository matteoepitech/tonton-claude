<p align="center">
  <img src=".github/assets/icon.png" width="112" alt="Tonton Claude icon">
</p>

<h1 align="center">Tonton Claude</h1>

<p align="center">
  <b>Control Claude Code running on all your machines from your Mac's notch.</b><br>
  Windows, Linux or another Mac: see every session, reply and approve permissions without leaving what you're doing.
</p>

<p align="center">
  <a href="https://github.com/matteoepitech/tonton-claude/releases/latest"><img src="https://img.shields.io/github/v/release/matteoepitech/tonton-claude?color=111&label=download" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/macOS-14%2B-111?logo=apple&logoColor=white" alt="macOS 14+">
  <img src="https://img.shields.io/badge/agents-Windows%20·%20macOS%20·%20Linux-111" alt="Windows, macOS, Linux">
  <img src="https://img.shields.io/badge/encryption-end--to--end-5E6AD2" alt="End-to-end encrypted">
  <img src="https://img.shields.io/badge/license-MIT-111" alt="MIT">
</p>

<p align="center">
  <img src=".github/assets/notch.png" alt="Tonton Claude open in the notch: sessions from three machines and a permission request">
</p>

## Why

You run Claude Code on your gaming PC, your laptop and a server. One of them is waiting for an approval, another one
finished ten minutes ago, and you only find out when you go check.

Tonton Claude puts all of them in your Mac's notch. Hover the camera and everything is there.

- **Every session, every machine.** Live status for each one: working, waiting for you, needs approval, done.
- **The whole conversation.** Messages, tool calls, code and images, as they happen.
- **Talk back.** Send a message or an image to any session, or one of your quick replies in a click.
- **Approve from anywhere.** A session asks for permission, the notch taps you on the shoulder, <kbd>⌘</kbd> <kbd>↩</kbd> and it carries on.
- **Stays out of the way.** At rest the notch looks untouched. Alerts, sounds, quiet hours and Focus modes are all up to you.
- **Private by design.** Everything is end-to-end encrypted. The relay can't read your conversations, and you can host your own.

## Get started

**1. Install the app on your Mac**

Download **TontonClaude.dmg** from the [latest release](https://github.com/matteoepitech/tonton-claude/releases/latest), open it and drag
Tonton Claude to Applications. It runs on Apple silicon and Intel Macs with macOS 14 or later.

If macOS says it can't check the app, open **System Settings › Privacy & Security** and click **Open Anyway**.
Prefer to build it yourself? See [building from source](docs/self-hosting.md#building-from-source).

**2. Create your account**

Open Tonton Claude, go to **Settings › Relay** and click **Create account**. Use the free hosted relay, or point it to your own.

**3. Add your machines**

**Settings › Machines** shows your token and the install line with it: copy the line for that computer and paste it in a
terminal there. The same token works for all your machines, like a RustDesk key.
The agent comes from the same release and runs in the background, with an icon next to the clock.

**4. Start claude**

Open a new terminal on that machine and run `claude` as usual. It shows up in your notch right away.

<p align="center">
  <img src=".github/assets/settings.png" alt="Tonton Claude settings: machines connected to your account">
</p>

## Good to know

- **Do I need a server?** No. The hosted relay at `tonton.d3l.tech` works out of the box. You can also
  [run your own](docs/self-hosting.md) in a few minutes.
- **Can the relay read my code?** No. Messages are encrypted on your machines with a key that never leaves them.
- **Which machines?** Anything that runs Claude Code: Windows, macOS and Linux.
- **From a browser or a phone.** `tonton-web.html`, published with each release, shows your sessions in any browser:
  open it, paste the recovery key from **Settings › Relay** or scan the QR code of **Settings › Machines** with the
  phone's camera, and chat, answer requests and stop sessions from there.
  It decrypts in the page, so the key never reaches the relay. It needs a relay from 0.8.0 or later, which also serves
  it at its own address: open the relay's URL in a browser. See [the details](docs/self-hosting.md#the-web-app).
- **On your iPhone.** The iPhone app in `ios/` shows the sessions, the conversations and the permission cards, with the
  sessions at work on the Lock Screen and in the Dynamic Island. It signs in with the recovery key: scan the QR code of
  **Settings › Machines › Phone or browser**, or paste the key. On a relay with an APNs key, permission requests come
  as notifications that only the phone can read, and the Live Activity keeps up while the app is closed. See [the details](docs/self-hosting.md#the-iphone-app).
- **From your wrist.** A permission alert has **Allow** and **Deny**: press it on the iPhone's Lock Screen, or on an
  Apple Watch, which shows the alerts of a locked iPhone. Allowing asks for the phone or the watch to be unlocked.
- **No Mac? Windows and Linux have an island.** `TontonClaude-Setup-….exe` on Windows, the `.deb` or the AppImage on
  Linux, in the latest release, put the sessions in a small island at the top of the screen, above your windows: it
  opens on the conversations and the permission requests. Sign in with the recovery key, or create your account there;
  its tray icon copies the install command for your machines. It works on GNOME and KDE, X11 and Wayland. The Windows
  installer is not signed yet, so SmartScreen asks you to confirm it. See [the details](docs/self-hosting.md#the-island-for-windows-and-linux).
- **Allow for this session.** A permission card also offers to allow calls like the one it asks for until the session
  ends: a command's first words (`npm test`, never what is chained after it), a site for web pages, any call of the other
  tools. The agent keeps the rule and drops it when the session ends.
- **Working as a team.** A pool puts the sessions of several people on one project: on the relay's website
  (`https://<relay>/`), **Pools** makes one, invites with a link or a QR code, and shows its task board, live. For a
  hackathon, give it the repository and the deadline: the orchestrator plans for the time left.
- **Showing a teammate.** In a conversation, the share menu › **Share read-only** copies a key for one session, valid for
  an hour, a day or a week. Your teammate pastes it in `tonton-web.html` and follows that session live, without being
  able to write to it. It has its own key: your account key stays with you. **Settings › Relay** lists the shares and
  revokes them.
- **OpenCode?** Yes: the installer adds a plugin to OpenCode when it finds it, and its sessions work in the notch like
  Claude Code's: messages, permissions, auto-approve rules, compact and interrupt. On this Mac, OpenCode 2's sessions
  show up and take messages even without the agent.
- **First launch.** Claude Code asks you to confirm "I am using this for local development" once per launch, because the
  feature Tonton Claude uses is still in preview.
- **Status line.** Claude Code only shares your plan's usage with status lines, so sessions started from a terminal get one
  from Tonton Claude: it passes the usage to the notch, then shows your own status line if you have one, or the model, the
  context and the 5-hour usage if you don't.
- **Updating agents.** When a machine runs an older agent than your app, **Update agent** shows up next to it in the notch
  and in **Settings › Machines**: one click and it installs the matching release. Agents installed before 0.4.0 need the
  install command once more, which the app copies for you.
- **What's new.** The first time a new version of the app starts, its release notes open, read from the release on GitHub.
  **Settings › General** turns that off, and its **What's new** link, next to the version, shows them again.
- **Starting a session.** <kbd>+</kbd> in the open notch, or <kbd>⌘</kbd> <kbd>N</kbd>, starts claude in a folder of any
  machine, in a tmux session you can attach to later. The machine needs tmux, so not Windows. The questions Claude Code
  asks on the way, like trusting the folder, show up in the notch: nothing is confirmed for you.
- **Naming a session.** Right-click a session › **Rename…** and type a name: it shows instead of the project on every
  Mac of the account, encrypted like the rest. **Show the project name** brings the project back.
- **Slash commands.** Claude Code doesn't let a channel run `/compact`, `/clear` or `/model`, so the notch types them in
  the session's terminal instead. That works for sessions running in tmux, like the ones started from the notch: a
  terminal icon in the session's header, once Claude is done. `/clear` asks first, and **Model** switches to Opus, Sonnet
  or Haiku. The header shows the model of every session.
- **Behind a proxy.** The agent goes through `HTTPS_PROXY` and skips the hosts in `NO_PROXY`, like curl. Set them before
  running the install line: the background service keeps the ones it was installed with. See
  [the details](docs/self-hosting.md#behind-a-proxy).
- **Diagnose a machine.** In **Settings › Machines**, **Diagnose** in a machine's menu has its agent check its setup: the
  background service, the relay, the hooks, the channel, the `claude` launcher, the status line and the OpenCode plugin.
  **Repair** next to a problem redoes that step of the install on the machine.
- **Agent log.** In **Settings › Machines**, **Show agent log** in a machine's menu reads the end of its log, sealed on the
  way. It says what the agent did, never what Claude wrote, and keys and tokens are taken out before it leaves.
- **Changing relay or account.** Click the Tonton Claude icon next to the clock on that machine › **Set token…** and paste
  the token from the app. **Regenerate** in Settings › Machines makes a new one: every machine is signed out until it gets it.
- **AppleScript and Shortcuts.** Scripts can read the sessions (`session list`, `session status "api"`) and, once
  **Settings › General › Scripts can send messages** is on, message Claude: `send message "run the tests" to "api"`. In
  Shortcuts, use the Run AppleScript action. The [Raycast extension](raycast/README.md) uses the same commands.
- **Shortcuts.** <kbd>⌥</kbd> <kbd>⌘</kbd> <kbd>N</kbd> opens the notch, <kbd>⌘</kbd> <kbd>1</kbd>…<kbd>9</kbd> jumps between sessions,
  <kbd>⌘</kbd> <kbd>.</kbd> interrupts the session at work, <kbd>esc</kbd> closes it.

## How it compares

| | Tonton Claude | Notch apps for Claude Code | Claude Code Remote Control |
|---|:---:|:---:|:---:|
| Lives in the Mac notch | ✅ | ✅ | — |
| Sessions from other machines | ✅ | — | ✅ |
| No browser or phone needed | ✅ | ✅ | — |
| Self-hostable, end-to-end encrypted | ✅ | local only | — |

## More

Security model, self-hosting and building from source: [docs/self-hosting.md](docs/self-hosting.md).

## License

MIT, made by [Del](https://github.com/matteoepitech).
