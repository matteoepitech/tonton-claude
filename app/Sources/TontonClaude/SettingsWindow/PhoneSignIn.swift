import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI
import TontonCore

/// Settings › Relay: a QR code the iPhone's camera opens in the Tonton Claude app, which signs it in to this account.
/// It holds the recovery key, so it stays hidden until asked for.
struct PhoneSignIn: View {
    let account: Account
    @State private var shown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Sign in on your iPhone: scan this with its Camera.").font(.system(size: 12)).foregroundStyle(Theme.textDim)
                Spacer()
                Button(shown ? "Hide QR code" : "Show QR code") { shown.toggle() }.buttonStyle(ThemeButtonStyle())
            }
            if shown, let image = Self.qrCode(account.signInLink) {
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 180, height: 180)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("QR code to sign in on iPhone")
            }
        }
    }

    /// Black on white, one pixel per module: the view scales it up without smoothing.
    static func qrCode(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
