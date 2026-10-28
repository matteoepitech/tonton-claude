import AppKit
import SwiftUI
import TontonCore

/// A separate window keeps the notch and urgent permissions reachable throughout a run.
@MainActor
final class RPGArenaWindow: NSObject, NSWindowDelegate {
    static let shared = RPGArenaWindow()
    private var window: NSWindow?
    func show() {
        if window == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 680, height: 550),
                styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = String(localized: "Tonton's arena")
            window.contentView = NSHostingView(rootView: RPGArenaView())
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            self.window = window
        }
        window?.makeKeyAndOrderFront(nil)
    }
    func windowDidResignKey(_ notification: Notification) { pause() }
    func windowWillClose(_ notification: Notification) { pause() }
    func windowDidMiniaturize(_ notification: Notification) { pause() }
    private func pause() { RPGStore.shared.arena?.pause(); RPGStore.shared.saveArena() }
}

struct RPGArenaView: View {
    @ObservedObject private var rpg = RPGStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var keys: Set<UInt16> = []
    var body: some View {
        VStack(spacing: 12) {
            if let run = rpg.arena {
                HStack {
                    Text("Wave \(run.wave)/3").font(.headline)
                    ProgressView(value: run.health, total: run.maxHealth)
                    Text("Health \(Int(run.health))/\(Int(run.maxHealth))").monospacedDigit()
                    Text("Pulse: \(Int(run.abilityCooldown.rounded(.up))) s").monospacedDigit()
                }
                ZStack {
                    Canvas { graphics, _ in
                        for enemy in run.enemies {
                            if enemy.warning > 0 {
                                let radius = enemy.kind == .boss ? 70.0 : 40.0
                                let area = CGRect(
                                    x: enemy.targetX - radius, y: enemy.targetY - radius, width: radius * 2, height: radius * 2)
                                graphics.fill(Path(ellipseIn: area), with: .color(.orange.opacity(0.25)))
                                graphics.stroke(
                                    Path(ellipseIn: area), with: .color(.orange), style: StrokeStyle(lineWidth: 3, dash: [6, 4]))
                                graphics.draw(
                                    Text("!").font(.title.bold()).foregroundStyle(.white), at: CGPoint(x: enemy.targetX, y: enemy.targetY))
                            }
                            let pixels =
                                enemy.kind == .boss
                                ? [".##..##.", "########", "#oo##oo#", "########", ".#kkkk#.", "..####..", ".##..##.", "##....##"]
                                : enemy.kind == .charger
                                    ? [".#....#.", "..####..", ".######.", "##o##o##", ".######.", "..####..", ".#....#.", "#......#"]
                                    : ["........", "..####..", ".######.", "##o##o##", "########", "########", ".######.", "..#..#.."]
                            let pixel = enemy.kind == .boss ? 6.0 : 3.5
                            let color: Color = enemy.kind == .boss ? .purple : enemy.kind == .charger ? .orange : .green
                            for (y, row) in pixels.enumerated() {
                                for (x, symbol) in row.enumerated() where symbol != "." {
                                    let square = CGRect(
                                        x: enemy.x + (Double(x) - 4) * pixel,
                                        y: enemy.y + (Double(y) - 4) * pixel, width: pixel, height: pixel)
                                    graphics.fill(Path(square), with: .color(symbol == "o" ? .white : symbol == "k" ? .black : color))
                                }
                            }
                            let maximum = enemy.kind == .boss ? 180.0 : enemy.kind == .charger ? 40.0 : 30.0
                            let bar = CGRect(x: enemy.x - 18, y: enemy.y - 4 * pixel - 7, width: 36, height: 3)
                            graphics.fill(Path(bar), with: .color(.white.opacity(0.2)))
                            graphics.fill(
                                Path(CGRect(x: bar.minX, y: bar.minY, width: 36 * max(0, enemy.health) / maximum, height: 3)),
                                with: .color(color))
                        }
                        if run.abilityCooldown > 4.8 && !reduceMotion {
                            graphics.stroke(
                                Path(ellipseIn: CGRect(x: run.x - 130, y: run.y - 130, width: 260, height: 260)),
                                with: .color(.cyan), lineWidth: 2)
                        }
                    }
                    MascotView(status: .working, size: 32, hero: rpg.hero, animated: run.phase == .playing)
                        .opacity(run.hitFlash > 0 && !reduceMotion ? 0.5 : 1)
                        .position(x: run.x, y: run.y)
                    if run.phase != .playing {
                        VStack(spacing: 10) {
                            if run.phase == .won {
                                Text("Victory!").font(.largeTitle.bold())
                                Text("Two waves and a boss: up to 105 XP, 14 sparks and a boss booster. Daily caps apply.")
                                if run.claimed {
                                    Text("Rewards saved. Upgrade Tonton for the next run.")
                                } else {
                                    Button("Claim victory rewards") { rpg.claimVictory() }.disabled(rpg.busy)
                                }
                            } else if run.phase == .lost {
                                Text("Defeated").font(.largeTitle.bold())
                                Text("No rewards lost. Try another route or upgrade Tonton.")
                            } else {
                                Text("Paused").font(.largeTitle.bold())
                                Button("Resume") {
                                    keys = []; rpg.arena?.resume()
                                }
                            }
                            if run.phase == .lost || run.claimed {
                                Button("New run") {
                                    keys = []; rpg.startArena()
                                }
                            }
                        }.multilineTextAlignment(.center).padding(24).background(
                            .ultraThickMaterial, in: RoundedRectangle(cornerRadius: 16))
                    }
                }
                .frame(width: 640, height: 400)
                .background(Color.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
                .overlay(
                    ArenaKeys(keys: $keys, active: run.phase == .playing, pause: { rpg.arena?.pause() }).allowsHitTesting(
                        run.phase == .playing)
                )
                .accessibilityLabel("Combat arena. Move with arrows or WASD, attack with Space, pulse with E, pause with Escape.")
                HStack {
                    Text("Arrows / WASD: move · Space: attack · E: pulse · Esc: pause").font(.caption)
                    Spacer()
                    Button("Pause") { rpg.arena?.pause() }.disabled(run.phase != .playing)
                }
                if let error = rpg.error { Text(error).font(.caption).foregroundStyle(.orange) }
            } else {
                Text("Connect an account and start a run from Tonton's panel.")
            }
        }
        .padding(20).background(Theme.bg).foregroundStyle(Theme.text)
        .onChange(of: rpg.arena?.phase) { _, _ in
            keys = []; rpg.saveArena()
        }
        .task(id: rpg.arena?.phase) {
            guard rpg.arena?.phase == .playing else { return }
            var previous = ProcessInfo.processInfo.systemUptime
            var saved = previous
            while !Task.isCancelled && rpg.arena?.phase == .playing {
                try? await Task.sleep(for: .milliseconds(16))
                guard !Task.isCancelled else { return }
                let now = ProcessInfo.processInfo.systemUptime
                let input = RPGCombat.Input(
                    x: (keys.contains(124) || keys.contains(2) ? 1 : 0) - (keys.contains(123) || keys.contains(0) ? 1 : 0),
                    y: (keys.contains(125) || keys.contains(1) ? 1 : 0) - (keys.contains(126) || keys.contains(13) ? 1 : 0),
                    attack: keys.contains(49), ability: keys.contains(14))
                rpg.arena?.advance(now - previous, input: input)
                previous = now
                if now - saved >= 1 { rpg.saveArena(); saved = now }
            }
        }
    }
}

/// Only this window's responder receives game keys. There is no global shortcut or permission input hook.
private struct ArenaKeys: NSViewRepresentable {
    @Binding var keys: Set<UInt16>
    var active: Bool
    var pause: () -> Void
    func makeNSView(context: Context) -> KeyView { let view = KeyView(); updateNSView(view, context: context); return view }
    func updateNSView(_ view: KeyView, context: Context) {
        view.changed = { keys = $0 }
        view.pause = pause
        if !active { view.held = [] }
        if active, let window = view.window, window.firstResponder !== view { window.makeFirstResponder(view) }
    }
    final class KeyView: NSView {
        var held: Set<UInt16> = []
        var changed: (Set<UInt16>) -> Void = { _ in }
        var pause: () -> Void = {}
        override var acceptsFirstResponder: Bool { true }
        override func viewDidMoveToWindow() { window?.makeFirstResponder(self) }
        override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 53 { held = []; changed(held); pause(); return }
            guard [0, 1, 2, 13, 14, 49, 123, 124, 125, 126].contains(event.keyCode) else { super.keyDown(with: event); return }
            held.insert(event.keyCode); changed(held)
        }
        override func keyUp(with event: NSEvent) { held.remove(event.keyCode); changed(held) }
        override func resignFirstResponder() -> Bool { held = []; changed(held); return true }
    }
}
