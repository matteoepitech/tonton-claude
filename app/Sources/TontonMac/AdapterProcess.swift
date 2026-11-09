import Foundation
import TontonCore

/// The processes Now Playing is read and driven through: mediaremote-adapter in `/usr/bin/perl`. A protocol, so that tests
/// start none.
@MainActor
public protocol ProcessLaunching: AnyObject {
    /// Starts a process that keeps running. Each line it writes goes to `line`, then its exit status to `exit`, on the main
    /// actor. Its standard input stays open, never written to, until `stop()` or until Tonton ends, however it ends.
    func stream(
        _ executable: URL, _ arguments: [String], line: @escaping @MainActor @Sendable (Data) -> Void,
        exit: @escaping @MainActor @Sendable (Int32) -> Void
    ) throws -> any RunningProcess

    /// Runs a process to its end and gives its exit status: nil when it could not start, or took too long and was stopped.
    func run(_ executable: URL, _ arguments: [String]) async -> Int32?
}

@MainActor
public protocol RunningProcess: AnyObject {
    /// Sends SIGTERM and closes its standard input. What it writes after is dropped.
    func stop()
}

/// The adapter's files in the app: scripts/build-app.sh builds the framework from app/Vendor/mediaremote-adapter into
/// Contents/Frameworks, and copies its script and `now-playing.pl` into Contents/Resources.
public struct AdapterFiles: Equatable, Sendable {
    public static let perl = URL(fileURLWithPath: "/usr/bin/perl")

    public let script: URL
    /// Runs the adapter's stream and stops it once Tonton is gone (Resources/now-playing.pl).
    public let watcher: URL
    public let framework: URL

    public init(script: URL, watcher: URL, framework: URL) {
        self.script = script
        self.watcher = watcher
        self.framework = framework
    }

    /// Nil when one is missing: a build from `swift build` has none of them, and a later macOS may have no perl.
    public static func inBundle(_ bundle: Bundle = .main) -> AdapterFiles? {
        guard let script = bundle.url(forResource: "mediaremote-adapter", withExtension: "pl"),
            let watcher = bundle.url(forResource: "now-playing", withExtension: "pl"),
            let framework = bundle.privateFrameworksURL?.appendingPathComponent("MediaRemoteAdapter.framework"),
            FileManager.default.fileExists(atPath: framework.appendingPathComponent("MediaRemoteAdapter").path),
            FileManager.default.isExecutableFile(atPath: perl.path)
        else { return nil }
        return AdapterFiles(script: script, watcher: watcher, framework: framework)
    }

    /// perl's arguments for the stream.
    public var streamArguments: [String] { [watcher.path, script.path, framework.path] + MediaRemoteAdapter.streamArguments }

    /// perl's arguments for `command`, nil for one Now Playing doesn't have.
    public func arguments(for command: MusicCommand) -> [String]? {
        MediaRemoteAdapter.arguments(for: command).map { [script.path, framework.path] + $0 }
    }
}

@MainActor
public final class SystemProcesses: ProcessLaunching {
    /// Nothing of the user's shell reaches the child: PERL5OPT or PERL5LIB would load other code into perl.
    static let environment = ["PATH": "/usr/bin:/bin"]
    /// The adapter's own commands wait two seconds at most for the player.
    static let commandTimeout: TimeInterval = 10

    public init() {}

    public func stream(
        _ executable: URL, _ arguments: [String], line: @escaping @MainActor @Sendable (Data) -> Void,
        exit: @escaping @MainActor @Sendable (Int32) -> Void
    ) throws -> any RunningProcess {
        let process = Self.process(executable, arguments)
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        let lines = Lines(line)
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil } else { lines.take(chunk) }
        }
        process.terminationHandler = { process in
            let status = process.terminationStatus
            DispatchQueue.main.async { MainActor.assumeIsolated { exit(status) } }
        }
        do {
            try process.run()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            throw error
        }
        return Child(process: process, input: input, output: output)
    }

    public func run(_ executable: URL, _ arguments: [String]) async -> Int32? {
        let process = Self.process(executable, arguments)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        return await withCheckedContinuation { continuation in
            let once = Once(continuation)
            process.terminationHandler = { process in
                once.resume(process.terminationReason == .exit ? process.terminationStatus : nil)
            }
            do {
                try process.run()
            } catch {
                once.resume(nil)
                return
            }
            let running = Running(process)
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + Self.commandTimeout) { running.stop() }
        }
    }

    private static func process(_ executable: URL, _ arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: "/")
        // What the adapter writes there can name what plays (a value it could not encode): it is never read.
        process.standardError = FileHandle.nullDevice
        return process
    }

    /// Cuts the output into lines off the main thread, and hands them over on it, in order.
    private final class Lines: @unchecked Sendable {
        private let lock = NSLock()
        private var buffer = LineBuffer()
        private let line: @MainActor @Sendable (Data) -> Void

        init(_ line: @escaping @MainActor @Sendable (Data) -> Void) { self.line = line }

        func take(_ chunk: Data) {
            let lines = lock.withLock { buffer.append(chunk) }
            guard !lines.isEmpty else { return }
            let line = self.line
            DispatchQueue.main.async { MainActor.assumeIsolated { lines.forEach(line) } }
        }
    }

    private final class Child: RunningProcess {
        private let process: Process
        /// Held until `stop()`: the watcher in the child stops the adapter once it closes.
        private let input: Pipe
        private let output: Pipe

        init(process: Process, input: Pipe, output: Pipe) {
            self.process = process
            self.input = input
            self.output = output
        }

        func stop() {
            output.fileHandleForReading.readabilityHandler = nil
            if process.isRunning { process.terminate() }
            try? input.fileHandleForWriting.close()
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Int32?, Never>?

        init(_ continuation: CheckedContinuation<Int32?, Never>) { self.continuation = continuation }

        func resume(_ status: Int32?) {
            lock.withLock {
                continuation?.resume(returning: status)
                continuation = nil
            }
        }
    }

    private final class Running: @unchecked Sendable {
        private let process: Process
        init(_ process: Process) { self.process = process }
        func stop() { if process.isRunning { process.terminate() } }
    }
}
