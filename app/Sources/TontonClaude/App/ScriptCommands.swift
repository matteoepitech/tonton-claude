import AppKit
import TontonCore

// The commands of Resources/TontonClaude.sdef. Cocoa scripting finds them by their Objective-C names and runs them on the
// main thread.

@objc(TontonSessionListCommand)
final class SessionListCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        MainActor.assumeIsolated {
            guard let store = AppDelegate.shared?.store else { return NSAppleEventDescriptor.list() }
            let showCost = AppSettings.shared.showCosts
            let list = NSAppleEventDescriptor.list()
            for session in store.visibleSessions {
                list.insert(ScriptRecord.make(ScriptSessions.fields(session, showCost: showCost)), at: 0)
            }
            return list
        }
    }
}

@objc(TontonSessionStatusCommand)
final class SessionStatusCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        MainActor.assumeIsolated {
            let sessions = AppDelegate.shared?.store.visibleSessions ?? []
            switch ScriptSessions.find(directParameter as? String ?? "", in: sessions) {
            case .success(let session): return session.status.rawValue
            case .failure(let failure): return fail(failure)
            }
        }
    }
}

@objc(TontonSendMessageCommand)
final class SendMessageCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        MainActor.assumeIsolated {
            guard let store = AppDelegate.shared?.store else { return nil }
            let text = directParameter as? String ?? ""
            let name = evaluatedArguments?["session"] as? String ?? ""
            switch ScriptSessions.recipient(name, text: text, in: store.visibleSessions, allowed: AppSettings.shared.scriptsCanSend) {
            case .success(let session):
                store.sendPrompt(text, images: [], to: session.id)
                return nil
            case .failure(let failure):
                return fail(failure)
            }
        }
    }
}

extension NSScriptCommand {
    /// Makes the script stop with the failure's message.
    fileprivate func fail(_ failure: ScriptSessions.Failure) -> Any? {
        scriptErrorNumber = Int(errAEEventFailed)
        scriptErrorString = failure.message
        return nil
    }
}

private enum ScriptRecord {
    /// 'usrf': the labels and values of a record whose labels a script defines, as AppleScript's own records keep them.
    private static let userFields = AEKeyword(0x7573_7266)

    static func make(_ fields: [(String, String)]) -> NSAppleEventDescriptor {
        let pairs = NSAppleEventDescriptor.list()
        for (label, value) in fields {
            pairs.insert(NSAppleEventDescriptor(string: label), at: 0)
            pairs.insert(NSAppleEventDescriptor(string: value), at: 0)
        }
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(pairs, forKeyword: userFields)
        return record
    }
}
