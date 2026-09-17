import AVFoundation
import CoreMedia
import Foundation
import ReplayCaptureCore
import Speech

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
        playback.prepare(
            renderFormat: engine.mainMixerNode.outputFormat(forBus: 0),
            engineProbe: EngineRunningProbe(engine)
        )

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
                        // A serial number, not an identity. With volatile
                        // results the transcriber reissues one phrase
                        // several times as it refines it, and each reissue
                        // gets its own id here; nothing downstream keys on
                        // this to replace an earlier partial. Keying it on
                        // `result.range` is what to do if anything ever
                        // needs to.
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

/// Everything the synthesiser and the player node touch.
/// `AVSpeechSynthesizer` delivers its buffers, and `AVAudioPlayerNode` its
/// playback completions, on AVFoundation's own threads, so none of this may
/// rely on actor isolation.
///
/// Two disciplines, deliberately separate:
///
/// - `lock` guards the bookkeeping, and **no AVFoundation call is ever made
///   while it is held**. `player.stop()` completes every buffer it
///   discards, and those completions reach `didPlayBuffer` on the node's
///   own thread, which takes this lock — so holding it across a node call
///   would be the two halves of an ordering cycle between a lock this code
///   owns and one it does not.
/// - `playerQueue` owns every `AVAudioPlayerNode` call, so they happen in
///   one known order on one known thread. Each scheduling decision is taken
///   on that queue, immediately before the buffer is handed over, which is
///   what stops a buffer being scheduled just after a stop has flushed the
///   node and then playing into whatever speaks next.
///
/// Together they implement `SpeechSynthesizing`'s per-utterance contract: a
/// stop names the utterance it means, and a stop that finds that utterance
/// not playing is remembered for that id alone.
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
    private let playerQueue = DispatchQueue(label: "Replay live speech", qos: .userInitiated)
    private let lock = NSLock()
    /// What the main mixer wants, and whether the engine behind the player
    /// node is still running. Both nil until the engine has actually
    /// started, which is what keeps an utterance from reaching a player
    /// node with no running engine behind it.
    private var renderFormat: AVAudioFormat?
    private var engineProbe: EngineRunningProbe?
    private var converter: AVAudioConverter?
    private var converterSourceFormat: AVAudioFormat?
    private var utterance: Utterance?
    /// Ids a stop arrived for while they were not playing: either the stop
    /// overtook its own `speak`, or that `speak` had already returned.
    private var stoppedIds: Set<String> = []
    private var closed = false

    fileprivate func prepare(renderFormat: AVAudioFormat, engineProbe: EngineRunningProbe) {
        lock.replayWithLock {
            self.renderFormat = renderFormat
            self.engineProbe = engineProbe
        }
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
        let probe = engineProbe
        lock.unlock()

        playerQueue.async { [self] in
            // Re-checked here rather than only at the call site: the engine
            // can stop itself in between, and `play()` on a stopped engine
            // is an error rather than a no-op.
            guard probe?.isRunning == true else { return }
            player.play()
        }
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
        lock.unlock()

        // The outcome above is set before either of these, so a scheduling
        // decision still to be taken on `playerQueue` will refuse, and one
        // already taken queued its buffer ahead of this flush, which
        // discards it. Neither call is made under the lock.
        synthesiser.stopSpeaking(at: .immediate)
        playerQueue.async { [self] in player.stop() }
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
        engineProbe = nil
        lock.unlock()

        synthesiser.stopSpeaking(at: .immediate)
        if wasRunning {
            // Synchronous, so the node is genuinely stopped before the
            // engine behind it is. Safe to block: nothing on this queue
            // waits on anything this thread holds.
            playerQueue.sync { [self] in player.stop() }
        }
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
              case let .success(rendered) = convertAudioBuffer(pcm, using: prepared.converter, to: prepared.format),
              rendered.frameLength > 0 else { return }
        let handoff = BufferHandoff(rendered)
        playerQueue.async { [self] in
            guard let ready = handoff.take() else { return }
            // Decided here, on the queue that owns the node, rather than
            // before the hop: a stop that lands in between has already set
            // `outcome`, so this refuses instead of scheduling onto a node
            // that has just been flushed. Counted before it is handed over,
            // so a completion that fires at once cannot overtake its own
            // buffer. The lock is released before the node is touched.
            let accepted: Bool = lock.replayWithLock {
                guard utterance?.id == utteranceId, utterance?.outcome == nil else { return false }
                utterance?.scheduledBuffers += 1
                return true
            }
            guard accepted else { return }
            // An utterance has finished playing when its last buffer's
            // `.dataPlayedBack` completion fires: the only signal that the
            // speaker, rather than just the synthesiser, is done with it.
            player.scheduleBuffer(ready, completionCallbackType: .dataPlayedBack) { @Sendable _ in
                self.didPlayBuffer(for: utteranceId)
            }
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

/// Everything the microphone tap touches. AVFAudio delivers tap buffers on
/// its own realtime queue, so this may not rely on actor isolation either.
///
/// It has two independent jobs, each with its own converter, because the
/// voice-processed tap format is neither something AAC can encode (it had
/// nine channels on the spike's Mac, all carrying the same signal) nor
/// something the analyser accepts.
///
/// Two disciplines again. `lock` guards the timing and the analyser's
/// continuation, both of which the tap callback touches directly.
/// `narrationQueue` owns the narration file: encoding AAC has no business
/// in a realtime callback with an ~85ms budget, least of all the leading
/// silence, which can be seconds of it.
@available(macOS 26, *)
final class MicrophoneTap: @unchecked Sendable {
    /// A clock reading that made no sense would otherwise ask for an
    /// unbounded amount of silence to be encoded.
    private static let maximumLeadingSilenceSeconds = 30.0

    private let captureOriginUptimeNanoseconds: UInt64
    private let fileFormat: AVAudioFormat
    private let analyzerFormat: AVAudioFormat
    private let fileConverter: AVAudioConverter
    private let analyzerConverter: AVAudioConverter
    private let narrationQueue = DispatchQueue(label: "Replay live narration", qos: .userInitiated)
    private let lock = NSLock()
    /// Confined to `narrationQueue`: nothing else reads or writes these
    /// once this object exists, and `init` sets them up before it does.
    private var file: AVAudioFile?
    private var firstNarrationFailure: Error?
    /// Guarded by `lock`.
    private var analyzerInput: AsyncStream<AnalyzerInput>.Continuation?
    private var firstBufferUptime: UInt64?
    private var firstAnalyzerFailure: Error?

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
        // Mix the tap's channels down rather than remapping the first one.
        // On the spike's Mac all nine carried the same signal, so either
        // would do; on hardware where they genuinely differ, a remap could
        // record silence. Deliberately not done for the analyser: its whole
        // value here rests on the echo-cancelled signal, and mixing in a
        // channel that turned out to be raw microphone could undo that.
        fileConverter.downmix = true
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
            // Not `try?`: narration is the user's own voice, so a file left
            // readable by other accounts is a privacy failure rather than a
            // cosmetic one.
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: audioURL.path
            )
        } catch {
            throw SidecarOperationError.ioFailed
        }
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
            narrationQueue.async { [self] in writeLeadingSilence(frames: leadingSilence) }
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

    /// Synchronous, so everything already queued is written before the file
    /// is released — which is what writes its trailer and closes it.
    func closeNarration() {
        narrationQueue.sync { [self] in file = nil }
    }

    /// `audio.m4a` must keep the invariant that its time zero is the
    /// capture origin, because Build transcribes it whenever
    /// `transcript.json` is absent. This engine starts after screen capture
    /// does, so the gap goes in ahead of the first real buffer as silence.
    /// On `narrationQueue`.
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
        while remaining > 0, file != nil {
            silence.frameLength = min(remaining, chunkFrames)
            write(silence)
            remaining -= silence.frameLength
        }
    }

    private func writeNarration(_ buffer: AVAudioPCMBuffer) {
        switch convertAudioBuffer(buffer, using: fileConverter, to: fileFormat) {
        case let .success(converted):
            guard converted.frameLength > 0 else { return }
            let handoff = BufferHandoff(converted)
            narrationQueue.async { [self] in
                guard let ready = handoff.take() else { return }
                write(ready)
            }
        case let .failure(error):
            narrationQueue.async { [self] in recordNarrationFailure(error) }
        }
    }

    private func feedAnalyzer(_ buffer: AVAudioPCMBuffer) {
        switch convertAudioBuffer(buffer, using: analyzerConverter, to: analyzerFormat) {
        case let .success(converted):
            guard converted.frameLength > 0 else { return }
            // No `bufferStartTime`: the analyser then takes each buffer as
            // following straight on from the last, which is exactly right
            // as long as the converted frames match the captured ones, and
            // `LiveAudioConversionTests` pins that they do. Labelling each
            // buffer with its source's own time-code would be worse, not
            // better — `AVAudioConverter` emits in fixed internal blocks
            // rather than one output buffer per input buffer, and the SDK
            // warns specifically that a converted buffer whose audio has
            // been shifted like that must not carry its source's start
            // time.
            lock.replayWithLock { analyzerInput }?.yield(AnalyzerInput(buffer: converted))
        case let .failure(error):
            lock.replayWithLock {
                if firstAnalyzerFailure == nil { firstAnalyzerFailure = error }
            }
        }
    }

    /// On `narrationQueue`. The first failure is recorded rather than
    /// discarded, and writing then stops: a format the encoder rejects
    /// fails on every single buffer, so `try?` here would both hide it and
    /// repeat it for the length of the recording.
    private func write(_ buffer: AVAudioPCMBuffer) {
        guard let file, firstNarrationFailure == nil else { return }
        do {
            try file.write(from: buffer)
        } catch {
            firstNarrationFailure = error
            self.file = nil
        }
    }

    /// On `narrationQueue`.
    private func recordNarrationFailure(_ error: Error) {
        guard firstNarrationFailure == nil else { return }
        firstNarrationFailure = error
        file = nil
    }
}

// MARK: - Shared audio helpers

/// Lets the speaking half ask, from the thread that owns the player node,
/// whether the engine behind it is still running — which
/// `AVAudioPlayerNode.play()` requires, and which an audio route change can
/// end without anything here being told. `AVAudioEngine` is not `Sendable`;
/// `isRunning` is a plain state read, and the engine serialises its own
/// control operations.
private final class EngineRunningProbe: @unchecked Sendable {
    private let engine: AVAudioEngine

    init(_ engine: AVAudioEngine) {
        self.engine = engine
    }

    var isRunning: Bool { engine.isRunning }
}

/// Hands one `AVAudioPCMBuffer` across a `@Sendable` boundary — a
/// converter's input block, or a dispatch queue hop — and gives it up on
/// the first `take()`.
///
/// `AVAudioPCMBuffer` is not `Sendable`, and both of those boundaries
/// require what they capture to be. Neither side needs a lock: each
/// hand-off has exactly one taker, and a queue hop carries the memory
/// barrier that makes the buffer visible there.
///
/// Giving it up is what matters for the converter.
/// `convertToBuffer:error:withInputFromBlock:` fills the output to its
/// *capacity*, and `AVAudioConverter.h` says of the block's packet count
/// that "you may supply more or less than this amount. If less, then the
/// input block will get called again" — so a block that keeps handing back
/// the same buffer makes the converter read it again from frame zero and
/// append the repeat to the output.
private final class BufferHandoff: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?

    init(_ buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func take() -> AVAudioPCMBuffer? {
        defer { buffer = nil }
        return buffer
    }
}

/// Headroom beyond the arithmetic frame count, so the converter is never
/// the one running out of room.
///
/// `AVAudioConverter` works in fixed internal blocks — measured at 4096
/// output frames on this hardware, for both a channel downmix and a 3:1
/// resample — and emits whole blocks rather than matching its output to the
/// buffer it was just given. Any leftover is held and comes out with a
/// later call, so an output buffer sized to the arithmetic count alone caps
/// every call short and leaves a backlog that never clears. With this much
/// headroom the backlog is always emptied, and the frames out match the
/// frames in exactly over a run of buffers, which is what the analyser's
/// contiguous timeline and the narration file's duration both rest on.
private let conversionMarginFrames: AVAudioFrameCount = 4_096

/// Converts one buffer into `format`. The narration file and the analyser
/// each need their own, at different sample rates and channel counts, which
/// is why neither can use the tap's buffers as they arrive.
func convertAudioBuffer(
    _ source: AVAudioPCMBuffer,
    using converter: AVAudioConverter,
    to format: AVAudioFormat
) -> Result<AVAudioPCMBuffer, Error> {
    let resampled = Double(source.frameLength) * format.sampleRate / source.format.sampleRate
    let capacity = AVAudioFrameCount(resampled.rounded(.up)) + conversionMarginFrames
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
        return .failure(SidecarOperationError.captureFailed)
    }
    let input = BufferHandoff(source)
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, status in
        guard let next = input.take() else {
            status.pointee = .noDataNow
            return nil
        }
        status.pointee = .haveData
        return next
    }
    switch status {
    case .haveData, .inputRanDry, .endOfStream:
        // `.inputRanDry` is the ordinary outcome here, not a failure: this
        // converter is given one buffer at a time, so it all but always
        // stops short of the headroom reserved above. The output buffer's
        // own `frameLength` is what was actually converted.
        return .success(output)
    case .error:
        return .failure(error ?? SidecarOperationError.captureFailed)
    @unknown default:
        return .failure(error ?? SidecarOperationError.captureFailed)
    }
}

/// A `CMTime` from the analyser as a non-negative offset in nanoseconds.
private func nanoseconds(from time: CMTime) -> UInt64 {
    guard time.isNumeric else { return 0 }
    return UInt64(max(0, time.seconds) * 1_000_000_000)
}
