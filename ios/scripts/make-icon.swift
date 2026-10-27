// Renders the iPhone app icon: the Mac icon's glyph (screen, notch, indigo session dot) on a full graphite square, which
// iOS rounds itself. Opaque, as the App Store wants. Run from ios/: swift scripts/make-icon.swift
import AppKit
import UniformTypeIdentifiers

let size = 1024
// No alpha channel at all: the App Store refuses icons that have one.
guard
    let bitmap = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else { fatalError("no bitmap") }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: bitmap, flipped: false)
let canvas = NSRect(x: 0, y: 0, width: size, height: size)
NSGradient(
    starting: NSColor(srgbRed: 0.17, green: 0.17, blue: 0.19, alpha: 1),
    ending: NSColor(srgbRed: 0.05, green: 0.05, blue: 0.06, alpha: 1))?
    .draw(in: canvas, angle: -90)

// The glyph of app/scripts/make-icon.swift, on its 18 pt grid, a little larger since nothing frames it here.
let k: CGFloat = 40
let origin = (CGFloat(size) - 18 * k) / 2
func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
    // The grid counts from the top.
    NSRect(x: origin + x * k, y: CGFloat(size) - origin - (y + h) * k, width: w * k, height: h * k)
}
NSColor(srgbRed: 0.97, green: 0.97, blue: 0.97, alpha: 1).set()
let screen = NSBezierPath(roundedRect: rect(1.75, 3.25, 14.5, 11.5), xRadius: 3.2 * k, yRadius: 3.2 * k)
screen.lineWidth = 1.5 * k
screen.stroke()
let notch = NSBezierPath(roundedRect: rect(6, 2.5, 6, 3.6), xRadius: 1.4 * k, yRadius: 1.4 * k)
notch.append(NSBezierPath(rect: rect(6, 2.5, 6, 1.8)))
notch.fill()
let glow = NSShadow()
glow.shadowColor = NSColor(srgbRed: 0.44, green: 0.44, blue: 1, alpha: 0.8)
glow.shadowBlurRadius = 60
glow.set()
NSColor(srgbRed: 0.44, green: 0.44, blue: 1, alpha: 1).setFill()
NSBezierPath(ovalIn: rect(7.4, 8.4, 3.2, 3.2)).fill()
NSGraphicsContext.restoreGraphicsState()

let output = URL(fileURLWithPath: "TontonClaude/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
guard let image = bitmap.makeImage(),
    let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)
else { fatalError("could not write \(output.path)") }
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("could not write \(output.path)") }
print("wrote \(output.path)")
