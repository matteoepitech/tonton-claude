import AppKit

/// On-screen panels of other apps that float above regular windows: Raycast (layer 8), Spotlight, alerts.
/// The Dock's full-screen click-through windows and everything from the Dock layer up (menu bar, status items) are left out.
enum FloatingWindows {
    /// Frames in AppKit screen coordinates.
    static func frames() -> [NSRect] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let primary = NSScreen.screens.first, let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[CFString: Any]]
        else { return [] }
        let floatingLayers = 1..<Int(CGWindowLevelForKey(.dockWindow))
        let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").map(\.processIdentifier)
        let skipped = Set(dock + [ProcessInfo.processInfo.processIdentifier])
        return windows.compactMap { info in
            guard let pid = info[kCGWindowOwnerPID] as? pid_t, !skipped.contains(pid), info[kCGWindowAlpha] as? Double ?? 1 > 0,
                let layer = info[kCGWindowLayer] as? Int, floatingLayers.contains(layer),
                let bounds = info[kCGWindowBounds] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds)
            else { return nil }
            // Window bounds use a top-left origin on the primary screen.
            return NSRect(x: rect.minX, y: primary.frame.maxY - rect.maxY, width: rect.width, height: rect.height)
        }
    }

    static func contain(_ point: NSPoint) -> Bool {
        frames().contains { $0.contains(point) }
    }

    static func overlap(_ frame: NSRect) -> Bool {
        frames().contains { $0.intersects(frame) }
    }
}
