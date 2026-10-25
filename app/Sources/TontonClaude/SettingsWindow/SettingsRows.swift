import SwiftUI

struct Row<Trailing: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .medium))
                if let detail {
                    Text(detail).font(.system(size: 12)).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
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
    let title: String
    let detail: String
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
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.textDim)
            .padding(.bottom, 8)
            .padding(.top, 26)
    }
}
