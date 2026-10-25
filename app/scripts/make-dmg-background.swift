// Draws the background of the installer window: the dotted backdrop of the README screenshots, an arrow from the app to
// Applications and a short hint. Run from app/: swift scripts/make-dmg-background.swift
// Writes Resources/dmg-background.png and its @2x version. Positions must match scripts/dmg-settings.py.
import AppKit

let size = CGSize(width: 640, height: 400)
let appCenter = CGPoint(x: 180, y: 190)
let applicationsCenter = CGPoint(x: 460, y: 190)

let paper = NSColor(srgbRed: 250 / 255, green: 250 / 255, blue: 251 / 255, alpha: 1)
let dot = NSColor(srgbRed: 196 / 255, green: 197 / 255, blue: 204 / 255, alpha: 1)
let accent = NSColor(srgbRed: 94 / 255, green: 106 / 255, blue: 210 / 255, alpha: 1)
let hint = NSColor(srgbRed: 128 / 255, green: 130 / 255, blue: 140 / 255, alpha: 1)

/// Finder coordinates have their origin at the top left; Core Graphics at the bottom left.
func flipped(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x, y: size.height - point.y) }

func draw() {
    paper.setFill()
    CGRect(origin: .zero, size: size).fill()

    // Dots everywhere but behind the icons, their labels, the arrow and the hint, which stay on a clean background.
    let spacing: CGFloat = 20
    let clearings = [
        CGRect(x: appCenter.x - 100, y: appCenter.y - 90, width: applicationsCenter.x - appCenter.x + 200, height: 195),
        CGRect(x: 150, y: 305, width: size.width - 300, height: 30),
    ]
    dot.setFill()
    for x in stride(from: spacing / 2, to: size.width, by: spacing) {
        for y in stride(from: spacing / 2, to: size.height, by: spacing) {
            guard !clearings.contains(where: { $0.contains(CGPoint(x: x, y: y)) }) else { continue }
            let center = flipped(CGPoint(x: x, y: y))
            NSBezierPath(ovalIn: CGRect(x: center.x - 1.1, y: center.y - 1.1, width: 2.2, height: 2.2)).fill()
        }
    }

    // Arrow between the two icons.
    let y = appCenter.y - 6
    let start = flipped(CGPoint(x: appCenter.x + 88, y: y))
    let end = flipped(CGPoint(x: applicationsCenter.x - 88, y: y))
    let arrow = NSBezierPath()
    arrow.move(to: start)
    arrow.line(to: end)
    arrow.move(to: CGPoint(x: end.x - 11, y: end.y + 11))
    arrow.line(to: end)
    arrow.line(to: CGPoint(x: end.x - 11, y: end.y - 11))
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    accent.setStroke()
    arrow.stroke()

    let text = NSAttributedString(
        string: "Drag Tonton Claude to Applications to install it",
        attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: hint])
    let textSize = text.size()
    // High enough to stay visible when Finder shows its path bar over the bottom of the window.
    text.draw(at: flipped(CGPoint(x: (size.width - textSize.width) / 2, y: 320 + textSize.height / 2)))
}

func render(scale: CGFloat, to path: String) {
    guard
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale), bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { fatalError("cannot allocate the bitmap") }
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("cannot encode \(path)") }
    try! png.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

render(scale: 1, to: "Resources/dmg-background.png")
render(scale: 2, to: "Resources/dmg-background@2x.png")
