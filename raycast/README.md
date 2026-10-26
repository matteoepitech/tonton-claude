# Tonton Claude for Raycast

**Claude Sessions** lists the Claude Code sessions in the notch, the ones that need you first. From the list:

- **Send Message** (↩) writes to a session, as if you typed in the notch.
- **Quick Reply** (⌘ R) sends one of the quick replies from Settings › General.
- **Open the Notch**, **Copy Session Id** and **Show Folder in Finder**.

It talks to the Tonton Claude app through its AppleScript dictionary, so the app must be running. Sending needs
**Settings › General › Automation › Scripts can send messages**. The first time, macOS asks whether Raycast may control
Tonton Claude.

## Develop

```sh
cd raycast
npm install
npm run dev      # opens the command in Raycast
npm run check    # TypeScript
```

The logic that does not need Raycast lives in `src/tonton.ts`. Its tests run with the other ones: `bun test` from the
repository root.
