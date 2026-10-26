import AppKit
import SwiftUI
import TontonCore

/// A month with Claude on one card, the same in Settings › Usage and in the image it saves or copies.
struct WrappedCard: View {
    let recap: WrappedLog.Recap
    /// Nil when costs are hidden.
    let spent: Double?

    static let size = CGSize(width: 360, height: 420)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("TONTON CLAUDE WRAPPED").font(.system(size: 10, weight: .bold)).tracking(1.6).opacity(0.75)
            Text(WrappedLog.title(recap.month)).font(.system(size: 22, weight: .bold)).padding(.top, 2)
            Spacer(minLength: 18)
            Text(WrappedLog.duration(recap.worked)).font(.system(size: 46, weight: .heavy, design: .rounded)).monospacedDigit()
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text("of Claude at work").font(.system(size: 13, weight: .medium)).opacity(0.8)
            Spacer(minLength: 18)
            Grid(alignment: .topLeading, horizontalSpacing: 18, verticalSpacing: 14) {
                GridRow {
                    figure("Top project", recap.topProject?.name, recap.topProject.map { WrappedLog.duration($0.value) })
                    figure(
                        "Most used tool", recap.topTool?.name,
                        recap.topTool.map { recap.toolCalls == 1 ? "1 call" : "\(Int($0.value)) of \(recap.toolCalls) calls" })
                }
                GridRow {
                    figure(
                        "Longest session", recap.longestSession.map { WrappedLog.duration($0.value) }, recap.longestSession?.name)
                    if let spent, spent > 0 {
                        figure("Spent", String(format: "$%.2f", spent), "at list price")
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Theme.onAccent)
        .padding(24)
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(
            ZStack {
                LinearGradient(colors: [Theme.accent, Theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing)
                Circle().fill(Theme.onAccent.opacity(0.08)).frame(width: 260).offset(x: 150, y: -150)
                Circle().fill(Theme.onAccent.opacity(0.06)).frame(width: 180).offset(x: -140, y: 170)
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    private func figure(_ label: String, _ value: String?, _ detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.8).opacity(0.7)
            Text(value ?? "—").font(.system(size: 16, weight: .bold)).lineLimit(1).truncationMode(.middle)
            if let detail { Text(detail).font(.system(size: 11)).opacity(0.75).lineLimit(1).truncationMode(.middle) }
        }
        .frame(width: 147, alignment: .leading)
    }

    /// The card as a PNG, at twice its size.
    @MainActor
    func png() -> Data? {
        let renderer = ImageRenderer(content: self)
        renderer.scale = 2
        guard let image = renderer.cgImage else { return nil }
        return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }
}

/// Settings › Usage's recap: a month picker, the card, and a way to share it.
struct WrappedSection: View {
    @ObservedObject var usage: UsageRecorder
    @EnvironmentObject var settings: AppSettings
    @State private var month: String?
    @State private var copied = false

    var body: some View {
        let months = usage.wrapped.recorded
        if let key = month.flatMap({ months.contains($0) ? $0 : nil }) ?? months.first, let recap = usage.wrapped.recap(key) {
            let card = WrappedCard(recap: recap, spent: settings.showCosts ? usage.history.spent(inMonth: key) : nil)
            HStack {
                GroupLabel(text: "Wrapped")
                Spacer()
                if months.count > 1 {
                    Picker("", selection: Binding(get: { key }, set: { month = $0 })) {
                        ForEach(months, id: \.self) { Text(WrappedLog.title($0)).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
            }
            HStack(alignment: .bottom, spacing: 16) {
                card
                VStack(alignment: .leading, spacing: 8) {
                    Button(copied ? "Copied" : "Copy image") { copy(card) }.buttonStyle(ThemeButtonStyle(primary: true))
                    Button("Save image…") { save(card, month: key) }.buttonStyle(ThemeButtonStyle())
                    Text("Project names show on the image: check it before you share it.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: 180, alignment: .leading)
            }
        }
    }

    private func copy(_ card: WrappedCard) {
        guard let png = card.png() else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setData(png, forType: .png)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }

    private func save(_ card: WrappedCard, month: String) {
        guard let png = card.png() else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.nameFieldStringValue = "tonton-wrapped-\(month).png"
        if panel.runAboveNotch() == .OK, let url = panel.url { try? png.write(to: url) }
    }
}
