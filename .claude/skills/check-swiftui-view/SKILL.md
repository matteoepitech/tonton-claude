---
name: check-swiftui-view
description: Render a SwiftUI view of the macOS app to a PNG at the notch's widths to check its layout, without launching the app. Use after changing a view in app/Sources/TontonClaude, before saying a UI change works.
---

# Checking a SwiftUI view without the app

The notch only opens on hover, so a view change can't be seen from a terminal or in CI. Compile the view with a tiny
renderer and look at the image.

## 1. Gather the sources

Copy into a scratch directory, outside the repository:

- the view's file and every file it uses from `app/Sources/TontonClaude` (often `Design/Theme.swift`);
- the `TontonCore` files it needs (`app/Sources/TontonCore/...`).

Everything is compiled as one module, so remove the `import TontonCore` lines from the copies.

## 2. Write `main.swift`

```swift
import AppKit
import SwiftUI

@MainActor func render(width: CGFloat, to path: String) {
    let view = MyView(/* realistic sample data, including long strings */)
        .foregroundStyle(Theme.text)
        .frame(width: width, alignment: .leading)
        .padding(12)
        .background(Theme.bg)
        .environment(\.colorScheme, .dark)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    guard let tiff = renderer.nsImage?.tiffRepresentation,
        let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
    else { fatalError("render failed") }
    try? png.write(to: URL(fileURLWithPath: path))
}

MainActor.assumeIsolated {
    render(width: 380, to: "compact.png")
    render(width: 500, to: "standard.png")
}
```

The widths are those of the chat column for the Compact and Standard notch sizes (`NotchSizeChoice` in
`Settings/Preferences.swift`, minus the 236 pt session list and the padding). Use the full panel width for views outside
the chat.

## 3. Build, run, look

```sh
swiftc -O -o render *.swift && ./render
```

Do not pass `-parse-as-library`: `main.swift` has top-level code. Open the PNGs and check long text (wraps or truncates
on purpose), alignment and contrast on the dark background.

## Limits

`ImageRenderer` does not show hover states, animations, scrolling or the real notch window. Say in the PR that the view
was checked this way and not on screen.
