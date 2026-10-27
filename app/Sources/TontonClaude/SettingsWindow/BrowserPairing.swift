import AppKit
import SwiftUI
import TontonCore

/// Settings › Machines: a QR code the web app scans to sign in on a phone or another computer, instead of typing the
/// recovery key. The code is that key, so it stays hidden until asked for, and goes away after a minute or as soon as the
/// window is left.
struct BrowserPairingCard: View {
    @EnvironmentObject var settings: AppSettings
    @Environment(\.controlActiveState) private var windowState
    @State private var code: QRCode?
    @State private var hidesAt = Date.distantPast
    @State private var failed = false

    private static let visibleFor: TimeInterval = 60
    private static let webApp = URL(string: "\(InstallCommand.releases)/tonton-web.html")

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Your phone or another browser").font(.system(size: 13, weight: .medium))
                Text(
                    """
                    Open the web app and scan this code to sign in there. It holds your recovery key: whoever scans it can read and \
                    drive your sessions, so show it to your own devices only.
                    """
                )
                .font(.system(size: 12))
                .foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
                if let code {
                    HStack(alignment: .center, spacing: 18) {
                        QRCodeView(code: code)
                        VStack(alignment: .leading, spacing: 10) {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                Text("Hides in \(max(0, Int(hidesAt.timeIntervalSince(context.date).rounded(.up)))) s")
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(Theme.textFaint)
                            }
                            Button("Hide") { hide() }.buttonStyle(ThemeButtonStyle())
                        }
                    }
                    .padding(.top, 4)
                } else {
                    if failed {
                        Text("The QR code could not be made. Copy the recovery key from Settings › Relay instead.")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.danger)
                    }
                    HStack(spacing: 8) {
                        Button("Show the QR code") { show() }.buttonStyle(ThemeButtonStyle())
                        if let webApp = Self.webApp {
                            Link("Download the web app", destination: webApp).font(.system(size: 12)).foregroundStyle(Theme.accent)
                        }
                    }
                }
            }
            .padding(16)
        }
        // Gone after a minute, when the window is no longer in front, and when the pane changes.
        .task(id: hidesAt) {
            guard code != nil else { return }
            try? await Task.sleep(for: .seconds(max(0, hidesAt.timeIntervalSinceNow)))
            if !Task.isCancelled { hide() }
        }
        .onChange(of: windowState) { _, state in if state == .inactive { hide() } }
        .onChange(of: settings.account) { hide() }
        .onDisappear { hide() }
    }

    private func show() {
        guard let account = settings.account else { return }
        code = QRCode(account.browserKey)
        failed = code == nil
        hidesAt = Date().addingTimeInterval(Self.visibleFor)
    }

    private func hide() {
        code = nil
        hidesAt = .distantPast
    }
}

/// Dark modules on white, with the quiet zone scanners need, whatever the theme. Whole points per module, so that none
/// comes out blurred or thinner than its neighbors.
struct QRCodeView: View {
    let code: QRCode
    var module: CGFloat = 3
    /// Modules of white around the code, as the standard asks.
    private let quietZone = 4

    var body: some View {
        let side = CGFloat(code.size + 2 * quietZone) * module
        Canvas { context, _ in
            context.fill(Path(CGRect(x: 0, y: 0, width: side, height: side)), with: .color(.white))
            var dark = Path()
            for y in 0..<code.size {
                for x in 0..<code.size where code.isDark(x: x, y: y) {
                    dark.addRect(
                        CGRect(x: CGFloat(x + quietZone) * module, y: CGFloat(y + quietZone) * module, width: module, height: module))
                }
            }
            context.fill(dark, with: .color(.black))
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityLabel("QR code to sign in on another device")
    }
}
