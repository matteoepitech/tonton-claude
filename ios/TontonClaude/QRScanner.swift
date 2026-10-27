import SwiftUI
import VisionKit

/// The camera, reading QR codes until one holds a recovery key. VisionKit does the reading: no dependency, and frames
/// never leave the phone. Not on the Simulator, nor on phones older than the A12 chip.
struct QRScanner: UIViewControllerRepresentable {
    /// Returns true once a code is accepted, which stops the camera.
    let found: (String) -> Bool

    @MainActor static var isAvailable: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Bool

        init(found: @escaping (String) -> Bool) {
            self.found = found
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                if let text = code.payloadStringValue, found(text) {
                    scanner.stopScanning()
                    return
                }
            }
        }
    }
}
