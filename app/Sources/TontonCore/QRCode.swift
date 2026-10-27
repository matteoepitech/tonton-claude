import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

/// The modules of a QR code, made by CoreImage. The view draws them as squares, so the code stays sharp at any size.
public struct QRCode: Equatable, Sendable {
    /// Modules per side, without the quiet zone around the code.
    public let size: Int
    /// Row by row, from the top left.
    private let modules: [Bool]

    /// Medium error correction: a code on a screen is read whole, and a lower level keeps the modules larger.
    public init?(_ text: String) {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let image = filter.outputImage else { return nil }
        let width = Int(image.extent.width)
        guard width > 2, Int(image.extent.height) == width else { return nil }
        // RGBA on the CPU, without color management: the format every renderer writes, and a few black and white pixels
        // need no GPU. Virtual machines without one, and gray formats there, left the bitmap blank.
        var pixels = [UInt8](repeating: 255, count: width * width * 4)
        let context = CIContext(options: [.useSoftwareRenderer: true, .workingColorSpace: NSNull()])
        context.render(image, toBitmap: &pixels, rowBytes: width * 4, bounds: image.extent, format: .RGBA8, colorSpace: nil)
        // CoreImage leaves a margin of one module: the view draws its own quiet zone.
        let size = width - 2
        let modules = (0..<size * size).map { pixels[(($0 / size + 1) * width + $0 % size + 1) * 4] < 128 }
        guard modules.contains(true) else { return nil }
        self.size = size
        self.modules = modules
    }

    init(size: Int, modules: [Bool]) {
        self.size = size
        self.modules = modules
    }

    public func isDark(x: Int, y: Int) -> Bool {
        x >= 0 && y >= 0 && x < size && y < size && modules[y * size + x]
    }

    /// The rows as `1` for dark modules and `0` for light ones.
    public var rows: [String] {
        (0..<size).map { y in String((0..<size).map { isDark(x: $0, y: y) ? "1" : "0" }) }
    }

    public init?(rows: [String]) {
        guard let first = rows.first, rows.allSatisfy({ $0.count == first.count && $0.allSatisfy("01".contains) }),
            first.count == rows.count
        else { return nil }
        self.init(size: rows.count, modules: rows.flatMap { $0.map { $0 == "1" } })
    }
}

extension Account {
    /// What a phone or a browser signs in with, for the QR code of Settings › Machines: the recovery key without the
    /// join secret, which the web app does not use. It still reads and drives every session.
    public var browserKey: String {
        with(joinSecret: nil).recoveryKey
    }
}
