// Menu bar icon of the Tonton Claude agent on macOS, started by `tonton service`.
// It shows the status the service writes and runs `tonton token` to connect to a relay and account.
// Exit codes read by the service: 0 Quit, 2 service gone, 3 icon hidden.
// Built by the release workflow: swiftc -O agent/tray/macos/main.swift -o tonton-tray
import AppKit

struct Options {
    var tonton = ""
    var status = ""
    var log = ""
    var servicePid: pid_t = 0

    init(_ arguments: [String]) {
        var iterator = arguments.dropFirst().makeIterator()
        while let name = iterator.next(), let value = iterator.next() {
            switch name {
            case "--tonton": tonton = value
            case "--status": status = value
            case "--log": log = value
            case "--service-pid": servicePid = pid_t(value) ?? 0
            default: break
            }
        }
    }
}

struct ServiceStatus: Decodable {
    let version: String
    let state: String
    let relay: String?
}

/// The glyph of the Tonton Claude app: a screen with the notch and one session dot.
let glyph: NSImage = {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
        let screen = NSBezierPath(roundedRect: NSRect(x: 1.75, y: 3.25, width: 14.5, height: 11.5), xRadius: 3.2, yRadius: 3.2)
        screen.lineWidth = 1.5
        NSColor.black.setStroke()
        screen.stroke()
        let notch = NSBezierPath(roundedRect: NSRect(x: 6, y: 2.5, width: 6, height: 3.6), xRadius: 1.4, yRadius: 1.4)
        notch.append(NSBezierPath(rect: NSRect(x: 6, y: 2.5, width: 6, height: 1.8)))
        NSColor.black.setFill()
        notch.fill()
        NSBezierPath(ovalIn: NSRect(x: 7.4, y: 8.4, width: 3.2, height: 3.2)).fill()
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Tonton Claude agent"
    return image
}()

final class Tray: NSObject, NSApplicationDelegate {
    private let options = Options(CommandLine.arguments)
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let title = NSMenuItem(title: "Tonton Claude", action: nil, keyEquivalent: "")
    private let state = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        installEditMenu()
        item.button?.image = glyph
        let menu = NSMenu()
        menu.autoenablesItems = false
        title.isEnabled = false
        state.isEnabled = false
        menu.addItem(title)
        menu.addItem(state)
        menu.addItem(.separator())
        menu.addItem(action("Set Token…", #selector(setToken)))
        menu.addItem(action("Open Log", #selector(openLog)))
        menu.addItem(action("Hide This Icon", #selector(hideIcon)))
        menu.addItem(.separator())
        menu.addItem(action("Quit", #selector(quit)))
        item.menu = menu
        refresh()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        item.target = self
        return item
    }

    private func refresh() {
        if options.servicePid > 0, kill(options.servicePid, 0) != 0, errno == ESRCH { exit(2) }
        guard let data = FileManager.default.contents(atPath: options.status),
            let status = try? JSONDecoder().decode(ServiceStatus.self, from: data)
        else { return }
        let host = status.relay.flatMap { URL(string: $0)?.host } ?? ""
        state.title =
            switch status.state {
            case "connected": "Connected to \(host)"
            case "connecting": "Connecting to \(host)…"
            case "revoked": "Token no longer valid: set the new one"
            default: "Not set up"
            }
        title.title = "Tonton Claude \(status.version)"
        item.button?.toolTip = "Tonton Claude: \(state.title)"
    }

    @objc private func setToken() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Set token"
        alert.informativeText = "Paste the token from Tonton Claude › Machines on your Mac."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24))
        field.placeholderString = "tonton_…"
        alert.accessoryView = field
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        DispatchQueue.global().async {
            let (ok, output) = self.runTonton(["token", value])
            DispatchQueue.main.async {
                let result = NSAlert()
                result.alertStyle = ok ? .informational : .warning
                result.messageText = ok ? "Connected" : "Could not use this token"
                result.informativeText = output
                NSApp.activate(ignoringOtherApps: true)
                result.runModal()
                self.refresh()
            }
        }
    }

    @objc private func openLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: options.log))
    }

    @objc private func hideIcon() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Hide the Tonton Claude icon?"
        alert.informativeText =
            "The agent keeps running. The icon comes back when you run the install command again, or with: tonton tray on"
        alert.addButton(withTitle: "Hide")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        _ = runTonton(["tray", "off"])
        exit(3)
    }

    @objc private func quit() {
        exit(0)
    }

    private func runTonton(_ arguments: [String]) -> (Bool, String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: options.tonton)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            return (false, error.localizedDescription)
        }
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        return (process.terminationStatus == 0, output.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Without a main menu, ⌘V and the other editing shortcuts do nothing in the token field.
    private func installEditMenu() {
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem()
        editItem.submenu = edit
        let main = NSMenu()
        main.addItem(editItem)
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let tray = Tray()
app.delegate = tray
app.run()
