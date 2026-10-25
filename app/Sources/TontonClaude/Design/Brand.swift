import AppKit
import SwiftUI

/// Menu bar glyph: a rounded screen outline with the notch at the top and one session dot.
/// Template image, so macOS tints it like the system icons (light/dark menu bar, highlight).
enum MenuBarIcon {
    static let image: NSImage = {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: true) { _ in
            let screen = NSBezierPath(roundedRect: NSRect(x: 1.75, y: 3.25, width: 14.5, height: 11.5), xRadius: 3.2, yRadius: 3.2)
            screen.lineWidth = 1.5
            NSColor.black.setStroke()
            screen.stroke()
            /// Notch hanging from the top edge of the screen.
            let notch = NSBezierPath(roundedRect: NSRect(x: 6, y: 2.5, width: 6, height: 3.6), xRadius: 1.4, yRadius: 1.4)
            notch.append(NSBezierPath(rect: NSRect(x: 6, y: 2.5, width: 6, height: 1.8)))
            NSColor.black.setFill()
            notch.fill()
            NSBezierPath(ovalIn: NSRect(x: 7.4, y: 8.4, width: 3.2, height: 3.2)).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Tonton Claude"
        return image
    }()
}

/// The same glyph inside the app (notch bar, settings), tinted like text.
struct TontonGlyph: View {
    var size: CGFloat = 16
    var color: Color = Theme.text

    var body: some View {
        Image(nsImage: MenuBarIcon.image)
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .foregroundStyle(color)
    }
}

struct Wordmark: View {
    var size: CGFloat = 15

    var body: some View {
        Text("Tonton Claude").font(.system(size: size, weight: .semibold)).tracking(-0.2).foregroundStyle(Theme.text)
    }
}
