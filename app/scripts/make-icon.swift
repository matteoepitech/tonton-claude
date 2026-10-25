// Renders Resources/AppIcon.icns: the app glyph (screen, notch, indigo session dot) on a graphite squircle.
import AppKit

func render(_ size: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: size, height: size), flipped: true) { r in
        let s = size / 1024
        let squircle = NSBezierPath(roundedRect: r.insetBy(dx: 100 * s, dy: 100 * s), xRadius: 185 * s, yRadius: 185 * s)
        NSGradient(
            starting: NSColor(srgbRed: 0.17, green: 0.17, blue: 0.19, alpha: 1),
            ending: NSColor(srgbRed: 0.05, green: 0.05, blue: 0.06, alpha: 1))!
            .draw(in: squircle, angle: 90)
        NSColor(white: 1, alpha: 0.10).setStroke()
        squircle.lineWidth = 4 * s
        squircle.stroke()
        // The app glyph (same geometry as MenuBarIcon, 18 pt grid scaled up): rounded screen, notch, session dot.
        let k = 34 * s, ox = 206 * s, oy = 206 * s
        func R(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
            NSRect(x: ox + x * k, y: oy + y * k, width: w * k, height: h * k)
        }
        NSColor(srgbRed: 0.97, green: 0.97, blue: 0.97, alpha: 1).set()
        let screen = NSBezierPath(roundedRect: R(1.75, 3.25, 14.5, 11.5), xRadius: 3.2 * k, yRadius: 3.2 * k)
        screen.lineWidth = 1.5 * k
        screen.stroke()
        let notch = NSBezierPath(roundedRect: R(6, 2.5, 6, 3.6), xRadius: 1.4 * k, yRadius: 1.4 * k)
        notch.append(NSBezierPath(rect: R(6, 2.5, 6, 1.8)))
        notch.fill()
        let glow = NSShadow()
        glow.shadowColor = NSColor(srgbRed: 0.44, green: 0.44, blue: 1, alpha: 0.8)
        glow.shadowBlurRadius = 50 * s
        NSGraphicsContext.saveGraphicsState()
        glow.set()
        NSColor(srgbRed: 0.44, green: 0.44, blue: 1, alpha: 1).setFill()
        NSBezierPath(ovalIn: R(7.4, 8.4, 3.2, 3.2)).fill()
        NSGraphicsContext.restoreGraphicsState()
        return true
    }
}

let set = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let px = CGFloat(base * scale)
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(px), pixelsHigh: Int(px), bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        render(px).draw(in: NSRect(x: 0, y: 0, width: px, height: px))
        NSGraphicsContext.restoreGraphicsState()
        let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        try! rep.representation(using: .png, properties: [:])!.write(to: set.appendingPathComponent(name))
    }
}
