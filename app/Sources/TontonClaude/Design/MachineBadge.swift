import SwiftUI
import TontonCore

/// The icon and color picked for a machine, next to its name.
struct MachineBadge: View {
    let style: MachineStyle
    var size: CGFloat = 10

    static let palette: [Color] = [
        Theme.accent, Color(nsColor: .systemBlue), Color(nsColor: .systemTeal), Color(nsColor: .systemGreen),
        Color(nsColor: .systemYellow), Color(nsColor: .systemOrange), Color(nsColor: .systemPink), Color(nsColor: .systemRed),
    ]

    static func color(_ index: Int?) -> Color? {
        index.flatMap { palette.indices.contains($0) ? palette[$0] : nil }
    }

    var body: some View {
        if let symbol = style.symbol, style.isEmoji {
            Text(symbol).font(.system(size: size))
        } else if let symbol = style.symbol {
            Image(systemName: symbol).font(.system(size: size, weight: .semibold)).foregroundStyle(Self.color(style.color) ?? .secondary)
        } else if let color = Self.color(style.color) {
            Circle().fill(color).frame(width: size * 0.7, height: size * 0.7)
        }
    }
}

/// Picks a machine's icon (a symbol or an emoji) and color.
struct MachineStylePicker: View {
    @Binding var style: MachineStyle
    @State private var emoji = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Icon").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.textDim)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(30), spacing: 6), count: 8), spacing: 6) {
                ForEach(MachineStyle.symbols, id: \.self) { symbol in
                    Button {
                        style.symbol = symbol
                    } label: {
                        Image(systemName: symbol)
                            .font(.system(size: 13))
                            .frame(width: 30, height: 30)
                            .foregroundStyle(MachineBadge.color(style.color) ?? Theme.text)
                            .background(RoundedRectangle(cornerRadius: 6).fill(style.symbol == symbol ? Theme.hover : Theme.raised))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(style.symbol == symbol ? Theme.accent : Theme.border))
                    }
                    .buttonStyle(.plain)
                }
            }
            ThemeField(placeholder: "Or an emoji", text: $emoji)
                .onChange(of: emoji) { _, text in if let emoji = MachineStyle.emoji(in: text) { style.symbol = emoji } }
            Text("Color").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.textDim)
            HStack(spacing: 8) {
                ForEach(MachineBadge.palette.indices, id: \.self) { index in
                    Button {
                        style.color = style.color == index ? nil : index
                    } label: {
                        Circle()
                            .fill(MachineBadge.palette[index])
                            .frame(width: 18, height: 18)
                            .overlay(Circle().stroke(Theme.text, lineWidth: style.color == index ? 2 : 0).padding(-3))
                    }
                    .buttonStyle(.plain)
                }
            }
            HStack {
                Spacer()
                Button("Reset") { style = MachineStyle() }.buttonStyle(ThemeButtonStyle())
            }
        }
        .padding(16)
        .frame(width: 300)
    }
}
