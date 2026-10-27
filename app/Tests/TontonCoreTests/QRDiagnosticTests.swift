import CoreImage
import CoreImage.CIFilterBuiltins
import XCTest

// Temporary: what CoreImage gives on the CI runner.
final class QRDiagnosticTests: XCTestCase {
    func testDiagnose() {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data("tonton1.diagnostic".utf8)
        filter.correctionLevel = "M"
        guard let image = filter.outputImage else { return print("DIAG no output image") }
        print("DIAG extent", image.extent)
        let width = Int(image.extent.width)
        let contexts: [(String, [CIContextOption: Any])] = [
            ("default", [:]), ("software", [.useSoftwareRenderer: true]),
            ("software-nocm", [.useSoftwareRenderer: true, .workingColorSpace: NSNull()]),
        ]
        for (name, options) in contexts {
            let context = CIContext(options: options)
            var rgba = [UInt8](repeating: 255, count: width * width * 4)
            context.render(image, toBitmap: &rgba, rowBytes: width * 4, bounds: image.extent, format: .RGBA8, colorSpace: nil)
            var gray = [UInt8](repeating: 255, count: width * width)
            context.render(
                image, toBitmap: &gray, rowBytes: width, bounds: image.extent, format: .L8, colorSpace: CGColorSpaceCreateDeviceGray())
            let cg = context.createCGImage(image, from: image.extent)
            let rgbaDark = stride(from: 0, to: rgba.count, by: 4).filter { rgba[$0] < 128 }.count
            print("DIAG", name, "rgba dark", rgbaDark, "gray dark", gray.filter { $0 < 128 }.count, "cg", cg?.width ?? -1)
        }
    }
}
