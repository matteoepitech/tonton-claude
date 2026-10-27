import AppKit
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
    /// In the language of the app, until the user changes them.
    static let defaultQuickReplies = [
        String(localized: "Continue"), String(localized: "Run the tests"), String(localized: "Explain what you just did"),
        String(localized: "Commit and push"),
    ]
    static let defaultTemplates = [
        PromptTemplate(
            name: String(localized: "Review a PR"),
            text: String(
                localized: "Review PR #{number}: read the diff with gh pr diff {number} and list what should change before merging.")),
        PromptTemplate(
            name: String(localized: "Fix an issue"),
            text: String(localized: "Fix issue #{number}: read it with gh issue view {number}, make the change and run the tests.")),
    ]
    /// macOS sounds by file name, which is also what the settings keep.
    static let alertSounds = ["Glass", "Tink", "Ping", "Pop", "Purr", "Hero", "Submarine", "Funk", "Bottle", "Frog", "Basso"]

    /// What the sound pickers show for a sound: in English its file name, in French the name System Settings gives it.
    static func soundLabel(_ name: String) -> String {
        switch name {
        case "Glass": String(localized: "Glass", comment: "A macOS alert sound")
        case "Tink": String(localized: "Tink", comment: "A macOS alert sound")
        case "Ping": String(localized: "Ping", comment: "A macOS alert sound")
        case "Pop": String(localized: "Pop", comment: "A macOS alert sound")
        case "Purr": String(localized: "Purr", comment: "A macOS alert sound")
        case "Hero": String(localized: "Hero", comment: "A macOS alert sound")
        case "Submarine": String(localized: "Submarine", comment: "A macOS alert sound")
        case "Funk": String(localized: "Funk", comment: "A macOS alert sound")
        case "Bottle": String(localized: "Bottle", comment: "A macOS alert sound")
        case "Frog": String(localized: "Frog", comment: "A macOS alert sound")
        case "Basso": String(localized: "Basso", comment: "A macOS alert sound")
        case "8-bit Coin": String(localized: "8-bit Coin", comment: "A sound of the 8-bit pack")
        case "8-bit Power-up": String(localized: "8-bit Power-up", comment: "A sound of the 8-bit pack")
        case "8-bit Alert": String(localized: "8-bit Alert", comment: "A sound of the 8-bit pack")
        case "8-bit Blip": String(localized: "8-bit Blip", comment: "A sound of the 8-bit pack")
        case "8-bit Error": String(localized: "8-bit Error", comment: "A sound of the 8-bit pack")
        default: name
        }
    }

    /// Relay
    @Published var serverURL: String
    @Published var account: Account?
    /// Every account signed in on this Mac, the connected one included (Settings › Relay).
    @Published var accounts: AccountList
    /// Off: the app stays disconnected from the relay.
    @Published var connectionEnabled: Bool

    /// General
    @Published var launchAtLogin: Bool
    @Published var showMenuBarIcon: Bool
    @Published var hotkey: HotKeyPreset
    @Published var display: DisplayChoice
    @Published var notchSize: NotchSizeChoice
    @Published var notchTextSize: NotchTextSize {
        didSet { Theme.textSize = notchTextSize }
    }
    @Published var showCosts: Bool
    /// AppleScript can always read the sessions; sending them messages needs this.
    @Published var scriptsCanSend: Bool
    /// Conversations go to Settings › Archive when their session ends.
    @Published var archiveFinished: Bool
    /// The release notes open once after each update.
    @Published var showWhatsNew: Bool
    /// The version whose notes were last shown, or that was installed fresh: "" before this setting existed.
    @Published var whatsNewVersion: String
    /// In dollars, 0 for none.
    @Published var dailyBudget: Int
    /// The last day the budget alert went off, so it only does once a day.
    @Published var budgetAlertDay: String
    /// In dollars, 0 for none.
    @Published var monthlyBudget: Int
    /// The last month the monthly budget alert went off, `2026-10`.
    @Published var budgetAlertMonth: String
    /// 0 keeps finished sessions until removed by hand.
    @Published var hideFinishedAfterHours: Int
    @Published var quickReplies: [String]
    /// Saved prompts with `{placeholders}`, inserted from the message field.
    @Published var promptTemplates: [PromptTemplate]
    /// Machines whose sessions stay out of the notch.
    @Published var hiddenMachines: Set<String>
    /// Icon and color per machine id.
    @Published var machineStyles: [String: MachineStyle]
    /// Tool calls agents approve without asking (Settings › Machines).
    @Published var autoApproveRules: [AutoApproveRule]
    /// When the rules last changed: agents keep only newer sets.
    @Published var autoApproveRulesDate: Date
    @Published var editor: EditorChoice
    @Published var terminal: TerminalChoice
    /// Session ids, in the order they were pinned.
    @Published var pinnedSessions: [String]
    /// A tag per project, by project name: the list groups their sessions under it.
    @Published var projectTags: [String: String]
    /// The pins of the accounts not connected, by `AccountList.id`, until the user switches back.
    @Published var parkedPins: [String: [String]]
    /// Folders sessions were started in from the notch, most recent first, per machine id.
    @Published var startFolders: [String: [String]]

    /// Notch and alerts
    @Published var openOnHover: Bool
    @Published var showActivityDots: Bool
    /// Tonton in the collapsed notch, in place of the status dot.
    @Published var showMascot: Bool
    /// The collapsed notch widens to show what the most relevant session is doing.
    @Published var liveActivity: Bool
    /// A light around the notch while a session works.
    @Published var workingGlow: Bool
    /// Live sessions as pills under the collapsed notch.
    @Published var showPills: Bool
    /// 0 is opaque, 0.5 the original glass, 1 the clearest (see GlassVeil).
    @Published var notchTransparency: Double
    @Published var theme: ThemeChoice {
        didSet { Theme.palette = theme.palette(contrast: contrast) }
    }
    /// The system's Increase Contrast, followed live. Not a preference of the app, so not saved.
    @Published private(set) var contrast: ContrastLevel {
        didSet { Theme.palette = theme.palette(contrast: contrast) }
    }
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
    /// The sound a project plays when it finishes, by project name. Others play the event's.
    @Published var projectSounds: [String: String]
    @Published var haptics: Bool
    @Published var systemNotifications: Bool
    @Published var quietHours: Bool
    /// Minutes after midnight.
    @Published var quietStart: Int
    @Published var quietEnd: Int
    /// A notification in the evening with the day's work (Settings › Notch).
    @Published var dailySummary: Bool
    /// Minutes after midnight.
    @Published var dailySummaryTime: Int
    /// The last day it went out, `2026-10-27`.
    @Published var dailySummaryDay: String

    /// Undo send: seconds a message from the notch waits before it goes (UndoSendDelay), 0 for right away.
    @Published var undoSendSeconds: Int
    var undoSendDelay: UndoSendDelay { UndoSendDelay(rawValue: undoSendSeconds) ?? .off }

    /// Webhooks (https only, see Webhook); empty is off.
    @Published var webhookFinished: String
    @Published var webhookNeedsYou: String
    @Published var webhookIncludeNames: Bool
    @Published var webhookIncludeLastMessage: Bool

    var isConfigured: Bool { account != nil }

    func sound(for event: SoundEvent) -> String { eventSounds[event.rawValue] ?? "Glass" }

    func sound(for event: SoundEvent, project: String) -> String {
        ProjectSound.pick(event, project: project, projectSounds: projectSounds, eventSound: sound(for: event))
    }
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
        let account = AccountStore.load()
        self.account = account
        var accounts = AccountStore.loadAll()
        // The account of a version that kept only one.
        if let account { accounts.save(account) }
        self.accounts = accounts
        connectionEnabled = value("connectionEnabled", true)
        launchAtLogin = SMAppService.mainApp.status == .enabled
        showMenuBarIcon = value("showMenuBarIcon", false)
        hotkey = choice("hotkey", .optionCommandN)
        display = choice("display", .builtIn)
        notchSize = choice("notchSize", .standard)
        let notchTextSize = choice("notchTextSize", NotchTextSize.standard)
        self.notchTextSize = notchTextSize
        Theme.textSize = notchTextSize
        showCosts = value("showCosts", true)
        scriptsCanSend = value("scriptsCanSend", false)
        archiveFinished = value("archiveFinished", false)
        showWhatsNew = value("showWhatsNew", true)
        whatsNewVersion = value("whatsNewVersion", "")
        dailyBudget = value("dailyBudget", 0)
        budgetAlertDay = value("budgetAlertDay", "")
        monthlyBudget = value("monthlyBudget", 0)
        budgetAlertMonth = value("budgetAlertMonth", "")
        hideFinishedAfterHours = value("hideFinishedAfterHours", 0)
        quickReplies = value("quickReplies", Self.defaultQuickReplies)
        promptTemplates =
            defaults.data(forKey: "promptTemplates").flatMap { try? JSONDecoder().decode([PromptTemplate].self, from: $0) }
            ?? Self.defaultTemplates
        hiddenMachines = Set(value("hiddenMachines", [String]()))
        machineStyles =
            defaults.data(forKey: "machineStyles").flatMap { try? JSONDecoder().decode([String: MachineStyle].self, from: $0) } ?? [:]
        autoApproveRules =
            defaults.data(forKey: "autoApproveRules").flatMap { try? JSONDecoder().decode([AutoApproveRule].self, from: $0) } ?? []
        autoApproveRulesDate = value("autoApproveRulesDate", Date(timeIntervalSince1970: 0))
        editor = choice("editor", EditorChoice.installed.first ?? .defaultApp)
        terminal = choice("terminal", .terminal)
        pinnedSessions = value("pinnedSessions", [String]())
        projectTags = value("projectTags", [String: String]())
        parkedPins = value("parkedPins", [String: [String]]())
        startFolders = value("startFolders", [String: [String]]())
        openOnHover = value("openOnHover", true)
        showActivityDots = value("showActivityDots", false)
        showMascot = value("showMascot", false)
        liveActivity = value("liveActivity", false)
        workingGlow = value("workingGlow", true)
        showPills = value("showPills", false)
        notchTransparency = value("notchTransparency", 0.5)
        let theme = choice("theme", ThemeChoice.midnight)
        self.theme = theme
        let contrast = Self.systemContrast
        self.contrast = contrast
        Theme.palette = theme.palette(contrast: contrast)
        openOnPermission = value("openOnPermission", false)
        showAlerts = value("showAlerts", true)
        alertOnFinish = value("alertOnFinish", false)
        confettiAfterMinutes = value("confettiAfterMinutes", 0)
        alertOnLimitReset = value("alertOnLimitReset", true)
        soundOnAttention = value("soundOnAttention", true)
        // Before sounds per event, one sound played for everything: it stays the sound of every event.
        let single = value("alertSound", "Glass")
        eventSounds = value("eventSounds", Dictionary(uniqueKeysWithValues: SoundEvent.allCases.map { ($0.rawValue, single) }))
        projectSounds = value("projectSounds", [String: String]())
        haptics = value("haptics", true)
        systemNotifications = value("systemNotifications", false)
        quietHours = value("quietHours", false)
        quietStart = value("quietStart", 22 * 60)
        quietEnd = value("quietEnd", 8 * 60)
        undoSendSeconds = value("undoSendSeconds", 0)
        dailySummary = value("dailySummary", false)
        dailySummaryTime = value("dailySummaryTime", 18 * 60)
        dailySummaryDay = value("dailySummaryDay", "")
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
        persist($notchTextSize.map(\.rawValue), "notchTextSize")
        persist($showCosts, "showCosts")
        persist($scriptsCanSend, "scriptsCanSend")
        persist($archiveFinished, "archiveFinished")
        persist($showWhatsNew, "showWhatsNew")
        persist($whatsNewVersion, "whatsNewVersion")
        persist($dailyBudget, "dailyBudget")
        persist($budgetAlertDay, "budgetAlertDay")
        persist($monthlyBudget, "monthlyBudget")
        persist($budgetAlertMonth, "budgetAlertMonth")
        persist($hideFinishedAfterHours, "hideFinishedAfterHours")
        persist($quickReplies, "quickReplies")
        persist($promptTemplates.compactMap { try? JSONEncoder().encode($0) }, "promptTemplates")
        persist($hiddenMachines.map { Array($0).sorted() }, "hiddenMachines")
        persist($machineStyles.map { try? JSONEncoder().encode($0.filter { !$0.value.isEmpty }) }, "machineStyles")
        persist($autoApproveRules.map { try? JSONEncoder().encode($0) }, "autoApproveRules")
        persist($autoApproveRulesDate, "autoApproveRulesDate")
        persist($editor.map(\.rawValue), "editor")
        persist($terminal.map(\.rawValue), "terminal")
        persist($pinnedSessions, "pinnedSessions")
        persist($projectTags, "projectTags")
        persist($parkedPins, "parkedPins")
        persist($startFolders, "startFolders")
        persist($openOnHover, "openOnHover")
        persist($showActivityDots, "showActivityDots")
        persist($showMascot, "showMascot")
        persist($liveActivity, "liveActivity")
        persist($workingGlow, "workingGlow")
        persist($showPills, "showPills")
        persist($notchTransparency, "notchTransparency")
        persist($theme.map(\.rawValue), "theme")
        persist($openOnPermission, "openOnPermission")
        persist($showAlerts, "showAlerts")
        persist($alertOnFinish, "alertOnFinish")
        persist($confettiAfterMinutes, "confettiAfterMinutes")
        persist($alertOnLimitReset, "alertOnLimitReset")
        persist($soundOnAttention, "soundOnAttention")
        persist($eventSounds, "eventSounds")
        persist($projectSounds, "projectSounds")
        persist($haptics, "haptics")
        persist($systemNotifications, "systemNotifications")
        persist($quietHours, "quietHours")
        persist($quietStart, "quietStart")
        persist($quietEnd, "quietEnd")
        persist($undoSendSeconds, "undoSendSeconds")
        persist($dailySummary, "dailySummary")
        persist($dailySummaryTime, "dailySummaryTime")
        persist($dailySummaryDay, "dailySummaryDay")
        persist($webhookFinished, "webhookFinished")
        persist($webhookNeedsYou, "webhookNeedsYou")
        persist($webhookIncludeNames, "webhookIncludeNames")
        persist($webhookIncludeLastMessage, "webhookIncludeLastMessage")

        $account.dropFirst().sink { [weak self] account in
            AccountStore.save(account)
            // New keys of the connected account, or a new account: the list keeps them for the next switch.
            if let account { self?.accounts.save(account) }
        }
        .store(in: &subscriptions)
        $accounts.removeDuplicates().sink { AccountStore.saveAll($0) }.store(in: &subscriptions)
        $launchAtLogin.dropFirst().removeDuplicates().sink { Self.setLaunchAtLogin($0) }.store(in: &subscriptions)
        // Posted on the workspace's own center when the user turns Increase Contrast on or off.
        NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.contrast = Self.systemContrast }
            .store(in: &subscriptions)
    }

    private static var systemContrast: ContrastLevel {
        NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? .increased : .standard
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
/// `account.json` is the connected one, as older versions expect; each account signed in on this Mac also has a file of
/// its own in `Accounts/`, so their keys stay apart.
enum AccountStore {
    private static var directory: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = support.appendingPathComponent("Tonton Claude")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return directory
    }

    private static var url: URL { directory.appendingPathComponent("account.json") }

    private static var files: AccountFiles { AccountFiles(directory: directory.appendingPathComponent("Accounts")) }

    static func loadAll() -> AccountList { files.load() }

    static func saveAll(_ list: AccountList) { files.save(list) }

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
