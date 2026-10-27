import AVFoundation
import OSLog
import Speech

/// Speech to text for the composer, with macOS speech recognition: on the Mac when it can, Apple's servers otherwise.
@MainActor
final class Dictation: ObservableObject {
    @Published private(set) var listening = false
    /// The words heard since `start`, revised as recognition goes.
    @Published private(set) var transcript = ""
    /// Why dictation could not start, for the composer to show.
    @Published var problem: String?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func start() {
        guard !listening else { return }
        transcript = ""
        problem = nil
        Task {
            guard await Self.authorized() else {
                problem = String(
                    localized: "Allow Tonton Claude to use the microphone and speech recognition in System Settings › Privacy & Security.")
                return
            }
            begin()
        }
    }

    func stop() {
        guard listening else { return }
        listening = false
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        // The last words still come through the task once the audio ends.
        request?.endAudio()
        request = nil
    }

    private func begin() {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            problem = String(localized: "Speech recognition isn't available for this language right now.")
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // What is said to Claude stays on the Mac whenever the language allows it.
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            problem = String(localized: "The microphone could not start: \(error.localizedDescription)")
            Logger.app.error("dictation: \(error.localizedDescription)")
            return
        }
        self.request = request
        listening = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, _ in
            guard let text = result?.bestTranscription.formattedString else { return }
            Task { @MainActor in self?.transcript = text }
        }
    }

    private static func authorized() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        return speech ? await AVCaptureDevice.requestAccess(for: .audio) : false
    }
}
