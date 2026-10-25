import AppKit
import SwiftUI

struct VisualEffect: NSViewRepresentable {
    let material: NSVisualEffectView.Material
    var alwaysActive = false

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        v.state = alwaysActive ? .active : .followsWindowActiveState
        return v
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

/// Compact switch: indigo when on, a dim groove when off.
struct AccentToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack {
            configuration.label
            Spacer(minLength: 12)
            ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                Capsule()
                    .fill(configuration.isOn ? Theme.accentDeep : Theme.hover)
                    .overlay(Capsule().stroke(configuration.isOn ? Color.clear : Theme.borderStrong))
                    .frame(width: 32, height: 18)
                Circle()
                    .fill(.white)
                    .frame(width: 14, height: 14)
                    .shadow(color: .black.opacity(0.3), radius: 1, y: 0.5)
                    .padding(2)
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { configuration.isOn.toggle() } }
        }
    }
}

struct IconTile: View {
    let systemName: String
    var tint: Color = Theme.textDim
    var size: CGFloat = 30

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.45, weight: .regular))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.24).fill(Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: size * 0.24).stroke(Theme.border))
    }
}

/// White primary button, or a quiet bordered secondary one.
struct ThemeButtonStyle: ButtonStyle {
    var primary = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(TightLabelStyle())
            .font(.system(size: 12.5, weight: .medium))
            .padding(.horizontal, 14)
            .frame(minWidth: 30, minHeight: 30)
            .foregroundStyle(primary ? Color.black : Theme.text)
            .background(RoundedRectangle(cornerRadius: 7).fill(primary ? Theme.text : Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(primary ? Color.clear : Theme.borderStrong))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(Rectangle())
    }
}

/// Icon and title closer together than the system default, icon slightly smaller than the text.
struct TightLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.font(.system(size: 11, weight: .semibold))
            configuration.title
        }
    }
}

struct Keycap: View {
    let key: String

    var body: some View {
        Text(key)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.textDim)
            .frame(minWidth: 20, minHeight: 20)
            .padding(.horizontal, 4)
            .background(RoundedRectangle(cornerRadius: 5).fill(Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.borderStrong))
    }
}

/// A bordered group of rows separated by hairlines.
struct Card<Content: View>: View {
    var padding: CGFloat = 0
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .padding(padding)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.035)))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border))
    }
}

struct ThemeField: View {
    let placeholder: String
    @Binding var text: String
    var secure = false
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if secure {
                SecureField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.textFaint))
            } else {
                TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.textFaint))
            }
        }
        .textFieldStyle(.plain)
        .font(Theme.mono)
        .foregroundStyle(Theme.text)
        .focused($focused)
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.35)))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(focused ? Theme.accent.opacity(0.7) : Theme.borderStrong))
    }
}
