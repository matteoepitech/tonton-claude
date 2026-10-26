import Combine
import Foundation
import OSLog
import ServiceManagement
import TontonCore

/// User preferences, persisted in UserDefaults, plus the account (stored separately, see AccountStore).
@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    static let defaultRelay = "https://tonton.d3l.tech"
    static let defaultQuickReplies = ["Continue", "Run the tests", "Explain what you just did", "Commit and push"]
    static let defaultTemplates = [
        PromptTemplate(
            name: "Review a PR",
            text: "Review PR #{number}: read the diff with gh pr diff {number} and list what should change before merging."),
        PromptTemplate(
            name: "Fix an issue", text: "Fix issue #{number}: read it with gh issue view {number}, make the change and run the tests."),
    ]
    static let alertSounds = ["Glass", "Tink", "Ping", "Pop", "Purr", "Hero", "Submarine", "Funk", "Bottle", "Frog", "Basso"]

    /// Relay
    @Published var serverURL: String
    @Published var account: Account?
    /// Off: the app stays disconnected from the relay.
    @Published var connectionEnabled: Bool

    /// General
    @Published var launchAtLogin: Bool
    @Published var showMenuBarIcon: Bool
    @Published var hotkey: HotKeyPreset
    @Published var display: DisplayChoice
    @Published var notchSize: NotchSizeChoice
    @Published var showCosts: Bool
    /// In dollars, 0 for none.
    @Published var dailyBudget: Int
    /// The last day the budget alert went off, so it only does once a day.
    @Published var budgetAlertDay: String
    /// 0 keeps finished sessions until removed by hand.
    @Published var hideFinishedAfterHours: Int
    @Published var quickReplies: [String]
    /// Saved prompts with `{placeholders}`, inserted from the message field.
    @Published var promptTemplates: [PromptTemplate]
    /// Machines whose sessions stay out of the notch.
    @Published var hiddenMachines: Set<String>
    /// Icon and color per machine id.
    @Published var machineStyles: [String: MachineStyle]
    @Published var editor: EditorChoice
    @Published var terminal: TerminalChoice
    /// Session ids, in the order they were pinned.
    @Published var pinnedSessions: [String]

    /// Notch and alerts
    @Published var openOnHover: Bool
    @Published var showActivityDots: Bool
    /// Tonton in the collapsed notch, in place of the status dot.
    @Published var showMascot: Bool
    /// The collapsed notch widens to show what the most relevant session is doing.
    @Published var liveActivity: Bool
    /// A light around the notch while a session works.
    @Published var workingGlow: Bool
    /// 0 is opaque, 0.5 the original glass, 1 the clearest (see GlassVeil).
    @Published var notchTransparency: Double
    @Published var openOnPermission: Bool
    @Published var showAlerts: Bool
    @Published var alertOnFinish: Bool
    /// Confetti when a session finishes after working at least this long, 0 for never.
    @Published var confettiAfterMinutes: Int
    /// When a session stopped by a usage limit can go again.
    @Published var alertOnLimitReset: Bool
    @Published var soundOnAttention: Bool
    /// The sound of each `SoundEvent`, by its raw value.
    @Published var eventSounds: [String: String]
    @Published var haptics: Bool
    @Published var systemNotifications: Bool
    @Published var quietHours: Bool
    /// Minutes after midnight.
    @Published var quietStart: Int
    @Published var quietEnd: Int

    /// Webhooks (https only, see Webhook); empty is off.
    @Published var webhookFinished: String
    @Published var webhookNeedsYou: String
    @Published var webhookIncludeNames: Bool
    @Published var webhookIncludeLastMessage: Bool

    var isConfigured: Bool { account != nil }

    func sound(for event: SoundEvent) -> String { eventSounds[event.rawValue] ?? "Glass" }
    var relayURL: String { account?.relay ?? serverURL }

    /// No sound, banner or notification while quiet hours are on.
    var isQuietNow: Bool {
        guard quietHours, quietStart != quietEnd else { return false }
        let time = Calendar.current.dateComponents([.hour, .minute], from: Date())
        let now = (time.hour ?? 0) * 60 + (time.minute ?? 0)
        return quietStart < quietEnd ? (now >= quietStart && now < quietEnd) : (now >= quietStart || now < quietEnd)
    }

    private let defaults: UserDefaults
    private var subscriptions = Set<AnyCancellable>()

    private init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        func value<T>(_ key: String, _ fallback: T) -> T { defaults.object(forKey: key) as? T ?? fallback }
        func choice<T: RawRepresentable<String>>(_ key: String, _ fallback: T) -> T {
            T(rawValue: defaults.string(forKey: key) ?? "") ?? fallback
        }

        serverURL = value("serverURL", Self.defaultRelay)
        account = AccountStore.load()
        connectionEnabled = value("connectionEnabled", true)
        launchAtLogin = SMAppService.mainApp.status == .enabled
        showMenuBarIcon = value("showMenuBarIcon", false)
        hotkey = choice("hotkey", .optionCommandN)
        display = choice("display", .builtIn)
        notchSize = choice("notchSize", .standard)
        showCosts = value("showCosts", true)
        dailyBudget = value("dailyBudget", 0)
        budgetAlertDay = value("budgetAlertDay", "")
        hideFinishedAfterHours = value("hideFinishedAfterHours", 0)
        quickReplies = value("quickReplies", Self.defaultQuickReplies)
        promptTemplates =
            defaults.data(forKey: "promptTemplates").flatMap { try? JSONDecoder().decode([PromptTemplate].self, from: $0) }
            ?? Self.defaultTemplates
        hiddenMachines = Set(value("hiddenMachines", [String]()))
        machineStyles =
            defaults.data(forKey: "machineStyles").flatMap { try? JSONDecoder().decode([String: MachineStyle].self, from: $0) } ?? [:]
        editor = choice("editor", EditorChoice.installed.first ?? .defaultApp)
        terminal = choice("terminal", .terminal)
        pinnedSessions = value("pinnedSessions", [String]())
        openOnHover = value("openOnHover", true)
        showActivityDots = value("showActivityDots", false)
        showMascot = value("showMascot", false)
        liveActivity = value("liveActivity", false)
        workingGlow = value("workingGlow", true)
        notchTransparency = value("notchTransparency", 0.5)
        openOnPermission = value("openOnPermission", false)
        showAlerts = value("showAlerts", true)
        alertOnFinish = value("alertOnFinish", false)
        confettiAfterMinutes = value("confettiAfterMinutes", 0)
        alertOnLimitReset = value("alertOnLimitReset", true)
        soundOnAttention = value("soundOnAttention", true)
        // Before sounds per event, one sound played for everything: it stays the sound of every event.
        let single = value("alertSound", "Glass")
        eventSounds = value("eventSounds", Dictionary(uniqueKeysWithValues: SoundEvent.allCases.map { ($0.rawValue, single) }))
        haptics = value("haptics", true)
        systemNotifications = value("systemNotifications", false)
        quietHours = value("quietHours", false)
        quietStart = value("quietStart", 22 * 60)
        quietEnd = value("quietEnd", 8 * 60)
        webhookFinished = value("webhookFinished", "")
        webhookNeedsYou = value("webhookNeedsYou", "")
        webhookIncludeNames = value("webhookIncludeNames", false)
        webhookIncludeLastMessage = value("webhookIncludeLastMessage", false)

        persist($serverURL, "serverURL")
        persist($connectionEnabled, "connectionEnabled")
        persist($showMenuBarIcon, "showMenuBarIcon")
        persist($hotkey.map(\.rawValue), "hotkey")
        persist($display.map(\.rawValue), "display")
        persist($notchSize.map(\.rawValue), "notchSize")
        persist($showCosts, "showCosts")
        persist($dailyBudget, "dailyBudget")
        persist($budgetAlertDay, "budgetAlertDay")
        persist($hideFinishedAfterHours, "hideFinishedAfterHours")
        persist($quickReplies, "quickReplies")
        persist($promptTemplates.compactMap { try? JSONEncoder().encode($0) }, "promptTemplates")
        persist($hiddenMachines.map { Array($0).sorted() }, "hiddenMachines")
        persist($machineStyles.map { try? JSONEncoder().encode($0.filter { !$0.value.isEmpty }) }, "machineStyles")
        persist($editor.map(\.rawValue), "editor")
        persist($terminal.map(\.rawValue), "terminal")
        persist($pinnedSessions, "pinnedSessions")
        persist($openOnHover, "openOnHover")
        persist($showActivityDots, "showActivityDots")
        persist($showMascot, "showMascot")
        persist($liveActivity, "liveActivity")
        persist($workingGlow, "workingGlow")
        persist($notchTransparency, "notchTransparency")
        persist($openOnPermission, "openOnPermission")
        persist($showAlerts, "showAlerts")
        persist($alertOnFinish, "alertOnFinish")
        persist($confettiAfterMinutes, "confettiAfterMinutes")
        persist($alertOnLimitReset, "alertOnLimitReset")
        persist($soundOnAttention, "soundOnAttention")
        persist($eventSounds, "eventSounds")
        persist($haptics, "haptics")
        persist($systemNotifications, "systemNotifications")
        persist($quietHours, "quietHours")
        persist($quietStart, "quietStart")
        persist($quietEnd, "quietEnd")
        persist($webhookFinished, "webhookFinished")
        persist($webhookNeedsYou, "webhookNeedsYou")
        persist($webhookIncludeNames, "webhookIncludeNames")
        persist($webhookIncludeLastMessage, "webhookIncludeLastMessage")

        $account.dropFirst().sink { AccountStore.save($0) }.store(in: &subscriptions)
        $launchAtLogin.dropFirst().removeDuplicates().sink { Self.setLaunchAtLogin($0) }.store(in: &subscriptions)
    }

    private func persist<P: Publisher>(_ publisher: P, _ key: String) where P.Failure == Never {
        publisher.dropFirst().sink { [defaults] in defaults.set($0, forKey: key) }.store(in: &subscriptions)
    }

    private static func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            Logger.app.error("launch at login: \(error.localizedDescription)")
        }
    }
}

/// The account lives in a file readable by the user only: Keychain access breaks on every rebuild of an ad-hoc signed app.
enum AccountStore {
    private static var url: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = support.appendingPathComponent("Tonton Claude")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return directory.appendingPathComponent("account.json")
    }

    static func load() -> Account? {
        try? JSONDecoder().decode(Account.self, from: Data(contentsOf: url))
    }

    static func save(_ account: Account?) {
        guard let account, let data = try? JSONEncoder().encode(account) else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])
    }
}
