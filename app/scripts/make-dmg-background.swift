// Draws the background of the installer window: the dotted backdrop of the README screenshots, an arrow from the app to
// Applications and a short hint. make-dmg.sh runs it on every build:
//   swift scripts/make-dmg-background.swift <output directory>
// Writes dmg-background.png and its @2x version, laid out from scripts/dmg-layout.json like scripts/dmg-settings.py.
import AppKit

struct Layout: Decodable {
    let width, height: CGFloat
    let app, applications: [CGFloat]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("make-dmg-background: \(message)\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2 else { fail("usage: swift make-dmg-background.swift <output directory>") }
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let layoutFile = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("dmg-layout.json")
let layout: Layout
do {
    layout = try JSONDecoder().decode(Layout.self, from: Data(contentsOf: layoutFile))
} catch {
    fail("cannot read \(layoutFile.path): \(error)")
}

// Finder coordinates: origin at the top left of the window content.
let appCenter = CGPoint(x: layout.app[0], y: layout.app[1])
let applicationsCenter = CGPoint(x: layout.applications[0], y: layout.applications[1])
// Runs past the layout so that a title bar shorter than dmg-settings.py assumes uncovers more backdrop, not the window.
let size = CGSize(width: layout.width, height: layout.height + 40)

let paper = NSColor(srgbRed: 250 / 255, green: 250 / 255, blue: 251 / 255, alpha: 1)
let dot = NSColor(srgbRed: 196 / 255, green: 197 / 255, blue: 204 / 255, alpha: 1)
let accent = NSColor(srgbRed: 94 / 255, green: 106 / 255, blue: 210 / 255, alpha: 1)
let hint = NSColor(srgbRed: 128 / 255, green: 130 / 255, blue: 140 / 255, alpha: 1)

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
            NSBezierPath(ovalIn: CGRect(x: x - 1.1, y: y - 1.1, width: 2.2, height: 2.2)).fill()
        }
    }

    // Arrow between the two icons.
    let y = appCenter.y - 6
    let start = CGPoint(x: appCenter.x + 88, y: y)
    let end = CGPoint(x: applicationsCenter.x - 88, y: y)
    let arrow = NSBezierPath()
    arrow.move(to: start)
    arrow.line(to: end)
    arrow.move(to: CGPoint(x: end.x - 11, y: end.y - 11))
    arrow.line(to: end)
    arrow.line(to: CGPoint(x: end.x - 11, y: end.y + 11))
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
    text.draw(at: CGPoint(x: (size.width - textSize.width) / 2, y: 320 - textSize.height / 2))
}

func render(scale: CGFloat, to name: String) {
    guard
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale), bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { fail("cannot allocate the bitmap") }
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSImage(size: size, flipped: true) { _ in
        draw()
        return true
    }.draw(in: CGRect(origin: .zero, size: size))
    NSGraphicsContext.restoreGraphicsState()
    let file = output.appendingPathComponent(name)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { fail("cannot encode \(file.path)") }
    do {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try png.write(to: file)
    } catch {
        fail("cannot write \(file.path): \(error)")
    }
    print("wrote \(file.path)")
}

render(scale: 1, to: "dmg-background.png")
render(scale: 2, to: "dmg-background@2x.png")
