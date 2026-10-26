import AppKit
import OSLog
import SwiftUI
import TontonCore

/// The release notes of the version the app runs, in a window like the settings: once after an update, or from
/// Settings › General. The notes come from the release on GitHub, so they are the ones the maintainer wrote.
@MainActor
final class WhatsNewWindowController {
    private let model = WhatsNewModel()
    private var window: NSWindow?

    /// Opens only once the notes are in: an update never greets the user with an error. Returns what GitHub said.
    func showAfterUpdate(version: String) async -> WhatsNew.Answer {
        let answer = await Self.fetch(version)
        guard case .notes(let release) = answer else { return answer }
        model.version = version
        model.state = .loaded(release)
        present()
        return answer
    }

    func show(version: String) {
        model.version = version
        // The notes of this run's version, once in, stay.
        if case .loaded = model.state { return present() }
        model.state = .loading
        present()
        Task {
            guard case .notes(let release) = await Self.fetch(version) else {
                if case .loading = model.state { model.state = .failed }
                return
            }
            model.state = .loaded(release)
        }
    }

    private func present() {
        let window = window ?? makeWindow()
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func makeWindow() -> NSWindow {
        let view = WhatsNewView(model: model) { [weak self] in self?.window?.close() }.environmentObject(AppSettings.shared)
        let host = NSHostingController(rootView: view)
        host.sizingOptions = []
        let window = NSWindow(contentViewController: host)
        window.title = "What's New"
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
        window.setContentSize(NSSize(width: 560, height: 600))
        window.center()
        return window
    }

    private static func fetch(_ version: String) async -> WhatsNew.Answer {
        guard let url = WhatsNew.releaseURL(for: version) else { return .none }
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        // At login the network may not be up yet: wait for it a little rather than fail at once.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForResource = 60
        let result = try? await URLSession(configuration: configuration).data(for: request)
        let answer = WhatsNew.Answer(status: (result?.1 as? HTTPURLResponse)?.statusCode, data: result?.0 ?? Data())
        if case .notes = answer { return answer }
        Logger.app.info("what's new: no release notes for \(version, privacy: .public)")
        return answer
    }
}

@MainActor
final class WhatsNewModel: ObservableObject {
    enum State {
        case loading
        case loaded(WhatsNew.Release)
        case failed
    }

    @Published var version = ""
    @Published var state = State.loading
}

struct WhatsNewView: View {
    @ObservedObject var model: WhatsNewModel
    let close: () -> Void
    /// Observed so the window redraws when the theme or Increase Contrast changes.
    @EnvironmentObject var settings: AppSettings

    private var page: URL? {
        if case .loaded(let release) = model.state { return release.page }
        return URL(string: "https://github.com/matteoepitech/tonton-claude/releases/tag/v\(model.version)")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text("What's new").font(Theme.title(22)).tracking(-0.4)
                Text("Tonton Claude \(model.version)").font(.system(size: 13)).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 32)
            .padding(.top, 44)
            .padding(.bottom, 20)
            ScrollView {
                notes.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 32).padding(.bottom, 20)
            }
            .scrollIndicators(.never)
            Rectangle().fill(Theme.border).frame(height: 1)
            HStack {
                if let page { Button("View on GitHub") { NSWorkspace.shared.open(page) }.buttonStyle(ThemeButtonStyle()) }
                Spacer()
                Button("OK", action: close).buttonStyle(ThemeButtonStyle(primary: true)).keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 32)
            .padding(.vertical, 16)
        }
        .frame(minWidth: 480, minHeight: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            ZStack {
                VisualEffect(material: Theme.palette.material, alwaysActive: true, scheme: Theme.palette.scheme)
                Theme.bg.opacity(0.8)
            }
        }
        .foregroundStyle(Theme.text)
        .environment(\.colorScheme, Theme.palette.scheme)
        .id(Theme.palette)
        .ignoresSafeArea()
    }

    @ViewBuilder private var notes: some View {
        switch model.state {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading the release notes…").font(.system(size: 13)).foregroundStyle(Theme.textDim)
            }
        case .loaded(let release):
            MarkdownText(text: WhatsNew.readable(release.body))
        case .failed:
            Text("The release notes could not be loaded. They are on GitHub too.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textDim)
        }
    }
}
