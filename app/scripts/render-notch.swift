// The open notch drawn to an image, with sample sessions, for the README (.github/assets/notch.png): built with the
// app's own views by render-notch.sh, in a window far off screen so AppKit draws the lists and the text field. Run it
// with a home of its own: nothing of this Mac's sessions or account gets in.
import AppKit
import SwiftUI
import TontonCore

@MainActor func sampleSessions() -> ([SessionSummary], [String: [Entry]], [MachineInfo]) {
    let now = Date()
    let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
    let machines = [
        MachineInfo(id: "m-mac", name: "MacBook-Pro", platform: "darwin", createdAt: ago(9000), lastSeen: now, online: true, agentVersion: "0.9.2"),
        MachineInfo(id: "m-studio", name: "PC-Studio", platform: "linux", createdAt: ago(9000), lastSeen: now, online: true, agentVersion: "0.9.2"),
        MachineInfo(id: "m-vps", name: "vps-paris", platform: "linux", createdAt: ago(9000), lastSeen: now, online: true, agentVersion: "0.9.2"),
    ]
    let session = { (id: String, machine: MachineInfo, project: String, title: String, status: SessionStatus, cost: Double, minutes: Double, permissions: [PermissionRequest], text: String?) in
        SessionSummary(
            id: id, machineId: machine.id, machine: machine.name, platform: machine.platform, cwd: "/home/me/code/\(project)", project: project,
            title: title, status: status, statusText: text, agentOnline: true, canChat: true, pendingPermissions: permissions, costUSD: cost,
            startedAt: ago(minutes), lastActivity: ago(0.5), lastMessage: nil, model: "claude-opus-4-5-20251101", branch: "main")
    }
    let permission = PermissionRequest(
        requestId: "req-1", toolName: "Bash", description: "Deploy the API to staging", inputPreview: #"{"command": "npm run deploy:staging"}"#,
        ts: ISO8601DateFormatter().string(from: now))
    let sessions = [
        session("s-landing", machines[0], "landing-page", "Redesign the hero section", .working, 1.12, 22, [], nil),
        session("s-docs", machines[1], "docs-site", "Translate the getting started guide", .idle, 0.21, 41, [], nil),
        session("s-api", machines[1], "api-server", "Rate limit the login endpoint", .permission, 0.84, 18, [permission], "Claude needs your permission to use Bash"),
        session("s-scraper", machines[2], "scraper", "Export pricing pages to CSV", .working, 0.37, 9, [], nil),
    ]
    let t = { (minutes: Double) in ISO8601DateFormatter().string(from: ago(minutes)) }
    let entries: [String: [Entry]] = [
        "s-api": [
            Entry(id: "e1", ts: t(6), kind: .user, text: "Add rate limiting to the /login endpoint, then deploy to staging", viaNotch: true),
            Entry(id: "e2", ts: t(5.8), kind: .assistant, text: "I'll add a sliding-window limiter to the auth routes and cover it with a test."),
            Entry(id: "e5", ts: t(5.2), kind: .tool, toolUseId: "t2", name: "Edit", summary: "src/routes/auth.ts"),
            Entry(id: "e6", ts: t(5.1), kind: .toolResult, toolUseId: "t2"),
            Entry(id: "e7", ts: t(4), kind: .tool, toolUseId: "t3", name: "Bash", summary: "npm test -- auth"),
            Entry(id: "e8", ts: t(3.5), kind: .toolResult, toolUseId: "t3"),
            Entry(id: "e9", ts: t(3), kind: .assistant, text: "Rate limiting is in place: **5 attempts per minute per IP**, with a 429 and a `Retry-After` header.\n\nAll 12 auth tests pass. Deploying to staging now."),
            Entry(id: "e10", ts: t(2.8), kind: .tool, toolUseId: "t4", name: "Bash", summary: "npm run deploy:staging"),
        ]
    ]
    return (sessions, entries, machines)
}

MainActor.assumeIsolated {
    _ = NSApplication.shared
    let settings = AppSettings.shared
    Theme.palette = ThemeChoice.midnight.palette
    let store = SessionStore(settings: settings)
    let (sessions, entries, machines) = sampleSessions()
    store.showSample(sessions: sessions, entries: entries, machines: machines, selected: "s-api")
    let state = NotchState()
    state.mode = .expanded
    state.notchSize = CGSize(width: 190, height: 32)
    let size = CGSize(width: 900, height: 640)
    let view = ExpandedView(onSettings: {})
        .environmentObject(state)
        .environmentObject(store)
        .environmentObject(settings)
        .foregroundStyle(Theme.text)
        .frame(width: size.width, height: size.height)
        .background(
            VStack(spacing: 0) {
                // The camera housing's band, black as on the Mac.
                Color.black.frame(height: 32)
                LinearGradient(colors: [Color(hex: 0x1c1c22), Color(hex: 0x141418)], startPoint: .top, endPoint: .bottom)
            }
        )
        .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 26, bottomTrailingRadius: 26))
        .environment(\.colorScheme, .dark)
        .environment(\.controlActiveState, .key)
    // A real window, far off screen: AppKit draws the lists, the scroll views and the text field as the app does.
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(origin: .zero, size: size)
    let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.contentView = host
    window.orderFrontRegardless()
    RunLoop.main.run(until: Date().addingTimeInterval(2.5))
    host.layoutSubtreeIfNeeded()
    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("no bitmap") }
    host.cacheDisplay(in: host.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("render failed") }
    try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
    window.orderOut(nil)
}
