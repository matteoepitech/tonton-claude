import Carbon.HIToolbox

/// Global ⌥⌘N shortcut through the Carbon hotkey API (no Accessibility permission needed).
final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void

    init(keyCode: UInt32 = UInt32(kVK_ANSI_N), modifiers: UInt32 = UInt32(optionKey | cmdKey), action: @escaping () -> Void) {
        self.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, data in
                guard let data else { return noErr }
                Unmanaged<HotKey>.fromOpaque(data).takeUnretainedValue().action()
                return noErr
            }, 1, &spec, me, &handler)
        RegisterEventHotKey(keyCode, modifiers, EventHotKeyID(signature: OSType(0x4E544348), id: 1), GetApplicationEventTarget(), 0, &ref)
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}

extension HotKeyPreset {
    /// Carbon key code and modifiers, nil when the shortcut is turned off.
    var carbon: (keyCode: UInt32, modifiers: UInt32)? {
        switch self {
        case .optionCommandN: (UInt32(kVK_ANSI_N), UInt32(optionKey | cmdKey))
        case .controlOptionSpace: (UInt32(kVK_Space), UInt32(controlKey | optionKey))
        case .optionCommandT: (UInt32(kVK_ANSI_T), UInt32(optionKey | cmdKey))
        case .controlOptionCommandC: (UInt32(kVK_ANSI_C), UInt32(controlKey | optionKey | cmdKey))
        case .off: nil
        }
    }
}
