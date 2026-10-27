import SwiftUI

/// A titled row of a settings card. Literal titles and details are looked up in the string catalog; `verbatim` shows a
/// name as it is (a project, a sound).
struct Row<Trailing: View>: View {
    let title: Text
    var detail: Text?
    @ViewBuilder let trailing: Trailing

    init(title: LocalizedStringKey, detail: LocalizedStringKey? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = Text(title)
        self.detail = detail.map { Text($0) }
        self.trailing = trailing()
    }

    init(verbatim title: String, detail: LocalizedStringKey? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = Text(title)
        self.detail = detail.map { Text($0) }
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                title.font(.system(size: 13, weight: .medium))
                if let detail {
                    detail.font(.system(size: 12)).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 16)
            trailing
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }
}

struct ToggleRow: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    @Binding var isOn: Bool

    var body: some View {
        Row(title: title, detail: detail) {
            Toggle("", isOn: $isOn).toggleStyle(AccentToggleStyle()).labelsHidden().fixedSize()
        }
    }
}

struct Hairline: View {
    var body: some View { Rectangle().fill(Theme.border).frame(height: 1) }
}

struct GroupLabel: View {
    let text: LocalizedStringKey
    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.textDim)
            .padding(.bottom, 8)
            .padding(.top, 26)
    }
}
