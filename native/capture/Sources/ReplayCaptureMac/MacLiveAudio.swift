import AVFoundation
import CoreMedia
import Foundation
import ReplayCaptureCore
import Speech

/// Returns a provider on systems with on-device streaming speech, and nil
/// elsewhere. The sidecar turns nil into an `unsupported` error.
///
/// Nothing here touches audio hardware. The provider only holds the state
/// that tracks speech-model installation; the microphone is not opened, and
/// no sound is produced, until `makeSession` builds a live session.
public func makeLiveAudioProvider() -> LiveAudioProviding? {
    if #available(macOS 26, *) {
        return MacLiveAudioProvider()
    }
    return nil
}

// MARK: - Provider

/// Owns the speech model's installation state, and builds one live session
/// per recording.
@available(macOS 26, *)
final class MacLiveAudioProvider: LiveAudioProviding, @unchecked Sendable {
    private struct ResolvedModel {
        let locale: Locale
        let transcriber: SpeechTranscriber
    }

    /// At most one installation per resolved locale, plus the failure an
    /// installation left behind if it threw. Guarded by a lock rather than
    /// actor isolation so that "is one already running?" is asked and
    /// acted on in the same uninterrupted stretch.
    private let lock = NSLock()
    private var installations: [String: Task<Void, Error>] = [:]
    private var unreportedFailures: [String: Error] = [:]

    func prepare(locale: String?) async throws -> LivePreparation {
        let model = try await resolveModel(locale: locale)
        let identifier = model.locale.identifier

        // Report a previous failure before looking at anything else, and
        // only once: this call throws, and the call after it finds nothing
        // recorded and starts a fresh installation.
        if let failure = lock.replayWithLock({ unreportedFailures.removeValue(forKey: identifier) }) {
            throw failure
        }

        switch await AssetInventory.status(forModules: [model.transcriber]) {
        case .installed:
            return .ready
        case .unsupported:
            // `supportedLocale(equivalentTo:)` already filtered the locale,
            // so this means the assets themselves cannot be had here.
            throw SidecarOperationError.unsupported(Self.unsupportedMessage(for: model.locale))
        case .supported, .downloading:
            // `.downloading` can mean an installation this process never
            // started — another app's, or an earlier run's. Asking again is
            // safe: the SDK documents that the system consolidates download
            // and installation requests without downloading anything twice.
            break
        @unknown default:
            break
        }

        startInstallingIfNeeded(model.transcriber, identifier: identifier)
        return .preparing
    }

    func makeSession(
        configuration: LiveAudioStartConfiguration,
        eventSink: @escaping @Sendable (SidecarLiveEventEnvelope) async -> Void
    ) async throws -> LiveAudioControlling {
        let model = try await resolveModel(locale: configuration.locale)
        // Never downloads. A recording must not stall behind a first-run
        // model download, so the sidecar refuses to start one until
        // `prepare(locale:)` has reported `.ready`.
        guard await AssetInventory.status(forModules: [model.transcriber]) == .installed else {
            throw SidecarOperationError.invalidState("The speech model is not ready yet.")
        }
        let engine = MacLiveAudioEngine(
            configuration: configuration,
            transcriber: model.transcriber
        )
        let coordinator = LiveAudioCoordinator(
            sessionId: configuration.sessionId,
            captureOriginUptimeNanoseconds: configuration.captureOriginUptimeNanoseconds,
            recogniser: engine,
            synthesiser: engine,
            eventSink: eventSink
        )
        try await coordinator.start()
        return coordinator
    }

    /// Resolves `locale` to one the on-device transcriber supports, and
    /// builds a transcriber configured for it. `prepare(locale:)` and
    /// `makeSession(configuration:eventSink:)` both come through here, so
    /// they can never disagree about which model a request means.
    private func resolveModel(locale: String?) async throws -> ResolvedModel {
        let requested = locale.map(Locale.init(identifier:)) ?? Locale.current
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
            throw SidecarOperationError.unsupported(Self.unsupportedMessage(for: requested))
        }
        return ResolvedModel(
            locale: supported,
            transcriber: SpeechTranscriber(
                locale: supported,
                transcriptionOptions: [],
                reportingOptions: [.volatileResults],
                attributeOptions: [.audioTimeRange]
            )
        )
    }

    private func startInstallingIfNeeded(_ transcriber: SpeechTranscriber, identifier: String) {
        lock.lock()
        guard installations[identifier] == nil else {
            lock.unlock()
            return
        }
        // Unstructured on purpose. `prepare` returns `.preparing` without
        // awaiting this, and an unstructured task inherits no cancellation
        // from whichever command happened to ask first, so a first-run
        // download outlives that command rather than being abandoned.
        let installation = Task { [weak self] in
            do {
                try await Self.install(transcriber)
                self?.finishInstalling(identifier: identifier, failure: nil)
            } catch {
                self?.finishInstalling(identifier: identifier, failure: error)
                throw error
            }
        }
        installations[identifier] = installation
        lock.unlock()
    }

    private func finishInstalling(identifier: String, failure: Error?) {
        lock.replayWithLock {
            installations.removeValue(forKey: identifier)
            if let failure {
                unreportedFailures[identifier] = failure
            }
        }
    }

    private static func install(_ transcriber: SpeechTranscriber) async throws {
        // Reserving the locale is not a step of its own: the SDK documents
        // that `AssetInventory` assigns the app's asset reservations to the
        // locale automatically when an installation request needs it.
        guard let request = try await AssetInventory.assetInstallationRequest(
            supporting: [transcriber]
        ) else {
            // Nothing to install: the assets were preinstalled, or another
            // app or an earlier call already fetched them.
            return
        }
        try await request.downloadAndInstall()
    }

    private static func unsupportedMessage(for locale: Locale) -> String {
        "Live speech recognition is not available for \(locale.identifier) on this Mac."
    }
}

// MARK: - The engine

/// One `AVAudioEngine` with voice processing enabled. The input tap feeds
/// both the recogniser and the narration file; synthesised speech plays
/// through the same engine, which is what lets macOS cancel it out of the
/// microphone.
///
/// An actor, so the lifecycle's own state can never be read across a
/// suspension by two callers at once — but nothing on the realtime audio
/// path is actor-isolated. Every audio callback below is an explicitly
/// `@Sendable` closure, which per SE-0420 inherits no isolation, and
/// touches only the lock-protected state in `MicrophoneTap` and
/// `SpeechPlayback`. The spike proved why this matters: an isolated
/// callback trapped with SIGTRAP the instant AVFAudio invoked it on its own
/// realtime queue.
@available(macOS 26, *)
actor MacLiveAudioEngine: SpeechRecognizing, SpeechSynthesizing {
    private let configuration: LiveAudioStartConfiguration
    private let transcriber: SpeechTranscriber
    private let engine = AVAudioEngine()
    private let playback = SpeechPlayback()
    private var tap: MicrophoneTap?
    private var analyzer: SpeechAnalyzer?
    private var resultsTask: Task<Void, Never>?
    /// The one setup and the one teardown. `stop()` awaits the start before
    /// tearing anything down, so setup and teardown can never interleave,
    /// however either is called; and a second `stop()` awaits the first
    /// rather than returning while it is still unwinding.
    private var startTask: Task<Void, Error>?
    private var teardownTask: Task<Void, Never>?
    private var stopped = false
    private var tornDown = false

    init(configuration: LiveAudioStartConfiguration, transcriber: SpeechTranscriber) {
        self.configuration = configuration
        self.transcriber = transcriber
    }

    // MARK: SpeechRecognizing

    func start(handler: @escaping @Sendable (RecognisedSegment) async -> Void) async throws {
        if let startTask {
            try await startTask.value
            return
        }
        let task = Task { try await self.performStart(handler: handler) }
        startTask = task
        try await task.value
    }

    func stop() async {
        stopped = true
        if let teardownTask {
            await teardownTask.value
            return
        }
        guard !tornDown else { return }
        let pendingStart = startTask
        let task = Task { [self] in
            // Let an in-flight start finish building before anything is
            // pulled out from under it. Its own failure is not this call's
            // business: whatever it managed to set up still needs tearing
            // down, and `start()`'s caller already sees the error.
            _ = try? await pendingStart?.value
            await performTeardown()
        }
        teardownTask = task
        await task.value
        tornDown = true
        // Both tasks captured this actor; releasing them here keeps a
        // stopped session from retaining itself.
        teardownTask = nil
        startTask = nil
        resultsTask = nil
    }

    private func performStart(handler: @escaping @Sendable (RecognisedSegment) async -> Void) async throws {
        // `stop()` ran before this got going: leave the microphone shut.
        guard !stopped else { return }

        let input = engine.inputNode
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            throw SidecarOperationError.captureFailed
        }
        // Voice processing ducks other applications' audio by default,
        // which would quieten whatever the user is recording. Keep it at
        // the minimum, with advanced ducking off.
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                enableAdvancedDucking: false,
                duckingLevel: .min
            )
        // The lazy mainMixer -> output connection is made at 44.1kHz, while
        // the hardware output and the voice-processed input both run at
        // 48kHz. Voice processing needs one shared rate to align the
        // speaker reference against the captured signal; left mismatched,
        // `engine.start()` throws kAUInitialize (-10875).
        engine.connect(
            engine.mainMixerNode,
            to: engine.outputNode,
            format: engine.outputNode.outputFormat(forBus: 0)
        )
        engine.attach(playback.player)
        engine.connect(playback.player, to: engine.mainMixerNode, format: nil)

        let tapFormat = input.outputFormat(forBus: 0)
        // Lives on `SpeechAnalyzer`, not `SpeechTranscriber`, and returns
        // nil when the modules still need assets installed.
        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber]
        ) else {
            throw SidecarOperationError.captureFailed
        }

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let tap: MicrophoneTap
        do {
            tap = try MicrophoneTap(
                captureOriginUptimeNanoseconds: configuration.captureOriginUptimeNanoseconds,
                audioURL: configuration.audioURL,
                tapFormat: tapFormat,
                analyzerFormat: analyzerFormat,
                analyzerInput: continuation
            )
        } catch {
            continuation.finish()
            throw error
        }
        // Recorded before the tap is installed, so teardown can always find
        // it however early it lands.
        self.tap = tap
        input.installTap(onBus: 0, bufferSize: 4_096, format: tapFormat) { @Sendable buffer, time in
            tap.receive(buffer, at: time)
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        do {
            try await analyzer.start(inputSequence: stream)
            // A stop landed while the analyser was starting. The microphone
            // is only actually opened by `engine.start()`, so there is no
            // reason to open it at all; the teardown that this task is
            // serialised ahead of unwinds everything built above.
            guard !stopped else { return }
            engine.prepare()
            try engine.start()
        } catch {
            throw SidecarOperationError.captureFailed
        }
        // Only now may anything be spoken: `AVAudioPlayerNode.play()` needs
        // a running engine, and the coordinator can queue speech while this
        // method is still suspended above.
        playback.prepare(renderFormat: engine.mainMixerNode.outputFormat(forBus: 0))

        let origin = configuration.captureOriginUptimeNanoseconds
        // Detached, so delivering a transcript never enters this actor: the
        // results loop cannot then interleave with a start or a teardown
        // suspended mid-step, and it needs nothing from here but the tap's
        // first buffer time, which is lock-protected.
        resultsTask = Task.detached { [transcriber] in
            var index = 0
            do {
                for try await result in transcriber.results {
                    index += 1
                    // The analyser's time zero is the first buffer it was
                    // given, not the capture origin: screen capture starts
                    // first, and this engine only starts once the sidecar
                    // has finished setting the recording up.
                    let anchor = tap.firstBufferUptimeNanoseconds ?? origin
                    await handler(RecognisedSegment(
                        segmentId: "segment-\(index)",
                        text: String(result.text.characters),
                        isFinal: result.isFinal,
                        startNanoseconds: anchor &+ nanoseconds(from: result.range.start),
                        endNanoseconds: anchor &+ nanoseconds(from: result.range.end)
                    ))
                }
            } catch {
                // A finished or cancelled analysis ends this loop, which is
                // the normal way a session closes. The coordinator reports a
                // genuine failure through its own state event.
            }
        }
    }

    private func performTeardown() async {
        // First, so nothing is left waiting on the speaker: every
        // outstanding `speak` returns false, one that registers afterwards
        // returns false at once, and the player falls silent.
        playback.close()
        if tap != nil {
            engine.inputNode.removeTap(onBus: 0)
        }
        // End the analyser's input, then let it work through the audio it
        // already has, so `transcriber.results` completes on its own rather
        // than being cut off mid-phrase.
        tap?.finishAnalyzerInput()
        if let analyzer {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
        }
        analyzer = nil
        engine.stop()
        tap?.closeNarration()
        tap = nil
        // A backstop only: finishing the analysis above ends the results
        // sequence, and so the loop, on its own.
        resultsTask?.cancel()
    }

    // MARK: SpeechSynthesizing

    func speak(_ text: String, utteranceId: String) async -> Bool {
        // `AVAudioPlayerNode.play()` requires a running engine, and the
        // engine can stop itself without being asked — an audio route
        // change is the usual way. Refusing the utterance reports that
        // honestly; playing into a stopped engine would not.
        guard engine.isRunning else { return false }
        guard playback.begin(text: text, utteranceId: utteranceId) else { return false }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            playback.attach(continuation, to: utteranceId)
        }
    }

    func stopSpeaking(utteranceId: String) async {
        playback.stop(utteranceId: utteranceId)
    }
}

// MARK: - The speaking half

/// Everything the synthesiser and the player node touch, behind one lock.
/// `AVSpeechSynthesizer` delivers its buffers, and `AVAudioPlayerNode` its
/// playback completions, on AVFoundation's own threads, so none of this may
/// rely on actor isolation.
///
/// Implements `SpeechSynthesizing`'s per-utterance contract: a stop names
/// the utterance it means, and a stop that finds that utterance not playing
/// is remembered for that id alone.
@available(macOS 26, *)
final class SpeechPlayback: @unchecked Sendable {
    /// One utterance's progress from registered to decided.
    private struct Utterance {
        let id: String
        var scheduledBuffers = 0
        var playedBuffers = 0
        var synthesisFinished = false
        /// Set once the utterance has either played out of the speaker or
        /// been stopped. Held until `speak`'s continuation claims it,
        /// because either can happen before that continuation exists.
        var outcome: Bool?
        var continuation: CheckedContinuation<Bool, Never>?
    }

    let player = AVAudioPlayerNode()
    private let synthesiser = AVSpeechSynthesizer()
    /// Recursive, because `player.stop()` completes every buffer it
    /// discards and is held under this lock — see `stop(utteranceId:)` for
    /// why that ordering is what keeps a stopped utterance's last buffers
    /// from playing into the next one.
    private let lock = NSRecursiveLock()
    /// What the main mixer wants. Nil until the engine is actually running,
    /// which is also what stops an utterance being handed to a player node
    /// that has no engine behind it yet.
    private var renderFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var converterSourceFormat: AVAudioFormat?
    private var utterance: Utterance?
    /// Ids a stop arrived for while they were not playing: either the stop
    /// overtook its own `speak`, or that `speak` had already returned.
    private var stoppedIds: Set<String> = []
    private var closed = false

    func prepare(renderFormat: AVAudioFormat) {
        lock.replayWithLock { self.renderFormat = renderFormat }
    }

    /// Registers `utteranceId` and starts synthesising it. Returns false,
    /// without playing anything, when a stop for that id arrived first,
    /// when the engine is not running, or once the session has been torn
    /// down.
    func begin(text: String, utteranceId: String) -> Bool {
        lock.lock()
        guard !closed, renderFormat != nil else {
            lock.unlock()
            return false
        }
        if stoppedIds.remove(utteranceId) != nil {
            lock.unlock()
            return false
        }
        // Registering forgets every other remembered stop. Each names an
        // utterance whose own `speak` has already returned, and ids are
        // never reused, so none of them can ever be claimed.
        stoppedIds.removeAll()
        utterance = Utterance(id: utteranceId)
        // Under the lock, so it can never land after `close()` has stopped
        // the player and the engine behind it.
        player.play()
        lock.unlock()

        // Outside the lock: the buffer callback takes it, and
        // `AVSpeechSynthesizer` is free to call back on any thread.
        synthesiser.write(AVSpeechUtterance(string: text)) { @Sendable buffer in
            self.receive(buffer, for: utteranceId)
        }
        return true
    }

    /// Attaches `speak`'s continuation. The utterance may already have been
    /// decided — it can play out, or be stopped, before `speak` reaches
    /// this point — in which case it resumes at once.
    func attach(_ continuation: CheckedContinuation<Bool, Never>, to utteranceId: String) {
        lock.lock()
        guard utterance?.id == utteranceId else {
            lock.unlock()
            // Only reachable once teardown has cleared the utterance
            // outright. Either way `speak` must not hang.
            continuation.resume(returning: false)
            return
        }
        if let outcome = utterance?.outcome {
            utterance = nil
            lock.unlock()
            continuation.resume(returning: outcome)
            return
        }
        utterance?.continuation = continuation
        lock.unlock()
    }

    /// Stops `utteranceId` if it is the one playing. Otherwise remembers
    /// the id, so its own `speak` — whether it is still to arrive, or has
    /// already returned — can never play.
    func stop(utteranceId: String) {
        lock.lock()
        guard var current = utterance, current.id == utteranceId, current.outcome == nil else {
            stoppedIds.insert(utteranceId)
            lock.unlock()
            return
        }
        current.outcome = false
        let continuation = current.continuation
        // Held with its outcome until `attach` claims it, if `speak` has
        // not reached that point yet.
        utterance = continuation == nil ? current : nil
        // Both calls stay under the lock, so that a buffer the synthesiser
        // is in the middle of handing over is either already scheduled —
        // and so discarded by `player.stop()` along with the rest — or
        // blocked in `receive` and then refused by the outcome just set.
        // Outside the lock, a straggler could be scheduled just after the
        // flush and would then play into whatever spoke next.
        synthesiser.stopSpeaking(at: .immediate)
        player.stop()
        lock.unlock()
        continuation?.resume(returning: false)
    }

    /// Silences the speaker for good: any outstanding `speak` returns
    /// false, and one that registers afterwards returns false at once
    /// without playing.
    func close() {
        lock.lock()
        closed = true
        // Only touch the player node if the engine actually got as far as
        // running: until then the node is not even attached to it, and a
        // stop that raced a suspended start can reach this point.
        let wasRunning = renderFormat != nil
        var continuation: CheckedContinuation<Bool, Never>?
        if var current = utterance {
            // An utterance that had already played out keeps its `true`:
            // it did finish, and `speak` should still say so.
            if current.outcome == nil { current.outcome = false }
            continuation = current.continuation
            utterance = continuation == nil ? current : nil
        }
        converter = nil
        converterSourceFormat = nil
        renderFormat = nil
        // Under the lock, for the same reason as `stop(utteranceId:)`.
        synthesiser.stopSpeaking(at: .immediate)
        if wasRunning { player.stop() }
        lock.unlock()
        continuation?.resume(returning: false)
    }

    /// Called on AVFoundation's synthesis thread, once per chunk of audio,
    /// and a final time with an empty buffer to say synthesis has finished.
    private func receive(_ buffer: AVAudioBuffer, for utteranceId: String) {
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        guard pcm.frameLength > 0 else {
            markSynthesisFinished(for: utteranceId)
            return
        }
        let prepared: (converter: AVAudioConverter, format: AVAudioFormat)? = lock.replayWithLock {
            guard utterance?.id == utteranceId,
                  utterance?.outcome == nil,
                  let renderFormat else { return nil }
            if converterSourceFormat != pcm.format {
                converter = AVAudioConverter(from: pcm.format, to: renderFormat)
                converterSourceFormat = converter == nil ? nil : pcm.format
            }
            guard let converter else { return nil }
            return (converter, renderFormat)
        }
        guard let prepared,
              case let .success(rendered) = convert(pcm, using: prepared.converter, to: prepared.format),
              rendered.frameLength > 0 else { return }
        // Counted and handed over in one stretch, under the same lock a
        // stop flushes the player under, so this buffer cannot slip in
        // just after that flush. Counted first, so a completion that fires
        // at once cannot overtake its own buffer.
        lock.lock()
        defer { lock.unlock() }
        guard utterance?.id == utteranceId, utterance?.outcome == nil else { return }
        utterance?.scheduledBuffers += 1
        // An utterance has finished playing when its last buffer's
        // `.dataPlayedBack` completion fires: the only signal that the
        // speaker, rather than just the synthesiser, is done with it.
        player.scheduleBuffer(rendered, completionCallbackType: .dataPlayedBack) { @Sendable _ in
            self.didPlayBuffer(for: utteranceId)
        }
    }

    private func markSynthesisFinished(for utteranceId: String) {
        lock.lock()
        guard utterance?.id == utteranceId, utterance?.outcome == nil else {
            lock.unlock()
            return
        }
        utterance?.synthesisFinished = true
        let settled = claimSettledUtteranceLocked()
        lock.unlock()
        settled?.resume(returning: true)
    }

    private func didPlayBuffer(for utteranceId: String) {
        lock.lock()
        guard utterance?.id == utteranceId, utterance?.outcome == nil else {
            lock.unlock()
            return
        }
        utterance?.playedBuffers += 1
        let settled = claimSettledUtteranceLocked()
        lock.unlock()
        settled?.resume(returning: true)
    }

    /// Marks the utterance finished once synthesis has ended and every
    /// buffer it produced has played out, and hands back the continuation
    /// to resume outside the lock. Nil when it is not finished, or when
    /// `speak` has not reached `attach` yet — in which case the outcome
    /// waits there instead.
    private func claimSettledUtteranceLocked() -> CheckedContinuation<Bool, Never>? {
        guard var current = utterance,
              current.outcome == nil,
              current.synthesisFinished,
              current.playedBuffers >= current.scheduledBuffers else { return nil }
        current.outcome = true
        guard let continuation = current.continuation else {
            utterance = current
            return nil
        }
        utterance = nil
        return continuation
    }
}

// MARK: - The listening half

/// Everything the microphone tap touches, behind one lock. AVFAudio
/// delivers tap buffers on its own realtime queue, so this may not rely on
/// actor isolation either.
///
/// It has two independent jobs, each with its own converter, because the
/// voice-processed tap format is neither something AAC can encode (it had
/// nine channels on the spike's Mac, all carrying the same signal) nor
/// something the analyser accepts.
@available(macOS 26, *)
final class MicrophoneTap: @unchecked Sendable {
    /// A clock reading that made no sense would otherwise ask for an
    /// unbounded allocation of silence.
    private static let maximumLeadingSilenceSeconds = 30.0

    private let captureOriginUptimeNanoseconds: UInt64
    private let fileFormat: AVAudioFormat
    private let analyzerFormat: AVAudioFormat
    private let fileConverter: AVAudioConverter
    private let analyzerConverter: AVAudioConverter
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var analyzerInput: AsyncStream<AnalyzerInput>.Continuation?
    private var firstBufferUptime: UInt64?
    /// The first narration failure, recorded rather than discarded, after
    /// which writing stops. A format the encoder rejects fails on every
    /// single buffer, so `try?` in the callback would both hide it and
    /// repeat it for the length of the recording.
    private(set) var firstNarrationFailure: Error?
    /// The first failed conversion on the way to the analyser. Unlike the
    /// narration file, this does not stop anything: a dropped buffer costs
    /// recognition a fraction of a second and the analyser carries on.
    private(set) var firstAnalyzerFailure: Error?

    /// The host uptime of the first buffer the microphone delivered, which
    /// is the analyser's own time zero.
    var firstBufferUptimeNanoseconds: UInt64? {
        lock.replayWithLock { firstBufferUptime }
    }

    init(
        captureOriginUptimeNanoseconds: UInt64,
        audioURL: URL,
        tapFormat: AVAudioFormat,
        analyzerFormat: AVAudioFormat,
        analyzerInput: AsyncStream<AnalyzerInput>.Continuation
    ) throws {
        // Mono at the tap's own sample rate. AAC rejects the channel count
        // voice processing exposes outright, and the narration file a
        // non-live recording writes is mono too, so Build sees the same
        // kind of file either way.
        guard let fileFormat = AVAudioFormat(
            standardFormatWithSampleRate: tapFormat.sampleRate,
            channels: 1
        ),
        let fileConverter = AVAudioConverter(from: tapFormat, to: fileFormat),
        let analyzerConverter = AVAudioConverter(from: tapFormat, to: analyzerFormat) else {
            throw SidecarOperationError.captureFailed
        }
        // No priming. A converter that shifted audio into a later buffer
        // would misalign both the narration file and the analyser's own
        // time-codes against the host times recorded here.
        fileConverter.primeMethod = .none
        analyzerConverter.primeMethod = .none
        do {
            file = try AVAudioFile(
                forWriting: audioURL,
                settings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: fileFormat.sampleRate,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderBitRateKey: 96_000
                ]
            )
        } catch {
            throw SidecarOperationError.ioFailed
        }
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: audioURL.path
        )
        self.captureOriginUptimeNanoseconds = captureOriginUptimeNanoseconds
        self.fileFormat = fileFormat
        self.analyzerFormat = analyzerFormat
        self.fileConverter = fileConverter
        self.analyzerConverter = analyzerConverter
        self.analyzerInput = analyzerInput
    }

    func receive(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        // `AVAudioTime.hostTime` counts in the same units as
        // `mach_absolute_time`, which is what
        // `DispatchTime.now().uptimeNanoseconds` reads; the framework's own
        // conversion is what makes the two comparable.
        let bufferUptime = time.isHostTimeValid
            ? UInt64(max(0, AVAudioTime.seconds(forHostTime: time.hostTime) * 1_000_000_000))
            : DispatchTime.now().uptimeNanoseconds
        let leadingSilence = lock.replayWithLock { () -> AVAudioFrameCount in
            guard firstBufferUptime == nil else { return 0 }
            firstBufferUptime = bufferUptime
            guard bufferUptime > captureOriginUptimeNanoseconds else { return 0 }
            let seconds = min(
                Double(bufferUptime - captureOriginUptimeNanoseconds) / 1_000_000_000,
                Self.maximumLeadingSilenceSeconds
            )
            return AVAudioFrameCount((seconds * fileFormat.sampleRate).rounded())
        }
        if leadingSilence > 0 {
            writeLeadingSilence(frames: leadingSilence)
        }
        writeNarration(buffer)
        feedAnalyzer(buffer)
    }

    /// No more audio for the analyser. Called before the analyser is asked
    /// to finish, so it can complete through the end of its input.
    func finishAnalyzerInput() {
        let continuation = lock.replayWithLock { () -> AsyncStream<AnalyzerInput>.Continuation? in
            let taken = analyzerInput
            analyzerInput = nil
            return taken
        }
        continuation?.finish()
    }

    /// Releasing the file writes its trailer and closes it.
    func closeNarration() {
        lock.replayWithLock { file = nil }
    }

    /// `audio.m4a` must keep the invariant that its time zero is the
    /// capture origin, because Build transcribes it whenever
    /// `transcript.json` is absent. This engine starts after screen
    /// capture does, so the gap goes in ahead of the first real buffer as
    /// silence.
    private func writeLeadingSilence(frames: AVAudioFrameCount) {
        let chunkFrames = min(frames, AVAudioFrameCount(fileFormat.sampleRate / 4))
        guard chunkFrames > 0,
              let silence = AVAudioPCMBuffer(pcmFormat: fileFormat, frameCapacity: chunkFrames),
              let channels = silence.floatChannelData else { return }
        // A freshly allocated buffer is not documented to be zeroed.
        for channel in 0..<Int(fileFormat.channelCount) {
            channels[channel].update(repeating: 0, count: Int(chunkFrames))
        }
        var remaining = frames
        while remaining > 0 {
            silence.frameLength = min(remaining, chunkFrames)
            guard write(silence) else { return }
            remaining -= silence.frameLength
        }
    }

    private func writeNarration(_ buffer: AVAudioPCMBuffer) {
        switch convert(buffer, using: fileConverter, to: fileFormat) {
        case let .success(converted):
            guard converted.frameLength > 0 else { return }
            _ = write(converted)
        case let .failure(error):
            recordNarrationFailure(error)
        }
    }

    private func feedAnalyzer(_ buffer: AVAudioPCMBuffer) {
        switch convert(buffer, using: analyzerConverter, to: analyzerFormat) {
        case let .success(converted):
            guard converted.frameLength > 0 else { return }
            lock.replayWithLock { analyzerInput }?.yield(AnalyzerInput(buffer: converted))
        case let .failure(error):
            lock.replayWithLock {
                if firstAnalyzerFailure == nil { firstAnalyzerFailure = error }
            }
        }
    }

    /// Holds the lock across the write, so closing the file can never race
    /// one. The tap is serial and nothing else contends for it, so this
    /// costs the audio thread nothing it was not already paying.
    private func write(_ buffer: AVAudioPCMBuffer) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let file, firstNarrationFailure == nil else { return false }
        do {
            try file.write(from: buffer)
            return true
        } catch {
            firstNarrationFailure = error
            self.file = nil
            return false
        }
    }

    private func recordNarrationFailure(_ error: Error) {
        lock.replayWithLock {
            guard firstNarrationFailure == nil else { return }
            firstNarrationFailure = error
            file = nil
        }
    }
}

// MARK: - Shared audio helpers

/// Hands a buffer to `AVAudioConverter`'s `@Sendable` input block.
/// `AVAudioPCMBuffer` is not `Sendable`, and the block is called
/// synchronously, on this thread, before `convert` returns — so there is
/// nothing to make thread-safe, only a capture rule to satisfy honestly
/// rather than by suppressing the diagnostic across the whole file.
private final class PCMBufferBox: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer

    init(_ buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }
}

/// Converts one buffer into `format`. Both the narration file and the
/// analyser need this, at different sample rates, which is why neither can
/// use the tap's buffers as they arrive.
private func convert(
    _ source: AVAudioPCMBuffer,
    using converter: AVAudioConverter,
    to format: AVAudioFormat
) -> Result<AVAudioPCMBuffer, Error> {
    let capacity = AVAudioFrameCount(
        Double(source.frameLength) * format.sampleRate / source.format.sampleRate
    ) + 1_024
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
        return .failure(SidecarOperationError.captureFailed)
    }
    let input = PCMBufferBox(source)
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
        status.pointee = .haveData
        return input.buffer
    }
    if let error {
        return .failure(error)
    }
    return .success(output)
}

/// A `CMTime` from the analyser as a non-negative offset in nanoseconds.
private func nanoseconds(from time: CMTime) -> UInt64 {
    guard time.isNumeric else { return 0 }
    return UInt64(max(0, time.seconds) * 1_000_000_000)
}
