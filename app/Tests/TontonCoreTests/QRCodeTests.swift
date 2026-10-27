import CoreImage
import XCTest

@testable import TontonCore

/// The QR code of Settings › Machines. web/test/swift-qr.json keeps one, which the web app's scanner must read
/// (web/test/scanner.test.ts); it is checked here on every run, and `TONTON_WRITE_VECTORS=1 swift test --filter QRCodeTests`
/// writes it again.
final class QRCodeTests: XCTestCase {
    private static let file = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("web/test/swift-qr.json")

    /// As long as a real account's.
    private let account = Account(
        relay: "https://relay.example.com", accountId: "abcdefghijkl", token: "ta_abcdefghijkl_" + String(repeating: "t", count: 43),
        key: E2E.newKey(), joinSecret: String(repeating: "s", count: 43))

    private struct Vector: Codable {
        let about: String
        let text: String
        let rows: [String]
    }

    func testTheCodeReadsBackAsTheKeyItHolds() throws {
        // Read once: JSONEncoder does not always write the keys in the same order.
        let key = account.browserKey
        let code = try XCTUnwrap(QRCode(key))
        XCTAssertEqual(Self.read(code), key)
        // Versions grow by 4 modules from 21.
        XCTAssertEqual(code.size % 4, 1)
        XCTAssertEqual(QRCode(rows: code.rows), code)
    }

    func testBrowsersGetTheRecoveryKeyWithoutTheJoinSecret() {
        XCTAssertEqual(Account(recoveryKey: account.browserKey), account.with(joinSecret: nil))
        XCTAssertLessThan(account.browserKey.count, account.recoveryKey.count)
    }

    func testRowsThatAreNotACodeAreRefused() {
        XCTAssertNil(QRCode(rows: []))
        XCTAssertNil(QRCode(rows: ["10", "01", "11"]))
        XCTAssertNil(QRCode(rows: ["12", "01"]))
    }

    func testTheWebAppsVectorIsACodeOfItsKey() throws {
        if ProcessInfo.processInfo.environment["TONTON_WRITE_VECTORS"] == "1" {
            let key = account.browserKey
            let vector = Vector(
                about: "Made by app/Tests/TontonCoreTests/QRCodeTests.swift, read by web/test/scanner.test.ts.", text: key,
                rows: try XCTUnwrap(QRCode(key)).rows)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(vector).write(to: Self.file)
        }
        let vector = try JSONDecoder().decode(Vector.self, from: Data(contentsOf: Self.file))
        XCTAssertEqual(Self.read(try XCTUnwrap(QRCode(rows: vector.rows))), vector.text)
        XCTAssertNotNil(Account(recoveryKey: vector.text))
    }

    /// What CoreImage's detector reads from the code drawn like the view draws it: dark on white, in a quiet zone.
    private static func read(_ code: QRCode) -> String? {
        let scale = 6
        let quiet = 4
        let side = (code.size + 2 * quiet) * scale
        guard
            let context = CGContext(
                data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: 0)
        else { return nil }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: side, height: side))
        context.setFillColor(gray: 0, alpha: 1)
        for y in 0..<code.size {
            // CGContext counts rows from the bottom.
            for x in 0..<code.size where code.isDark(x: x, y: y) {
                context.fill(CGRect(x: (x + quiet) * scale, y: side - (y + quiet + 1) * scale, width: scale, height: scale))
            }
        }
        guard let image = context.makeImage(),
            let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        else { return nil }
        return detector.features(in: CIImage(cgImage: image)).compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first
    }
}
