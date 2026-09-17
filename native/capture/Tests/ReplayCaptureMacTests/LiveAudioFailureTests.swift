import AVFoundation
import Foundation
import Speech
import Testing
@testable import ReplayCaptureMac

/// `LiveAudioFailureReporter` is the one path a live audio failure takes
/// from wherever it is noticed to the coordinator. It is a lock, a handler
/// and a notification observer: nothing here builds an `AVAudioEngine`,
/// opens the microphone or makes a sound, and
/// `AVAudioEngineConfigurationChange` is only a name, which any object can
/// be the subject of.
///
/// `MicrophoneTap` is reachable from here for the same reason: it opens an
/// `AVAudioFile` and builds two `AVAudioConverter`s, none of which is a
/// device. Given a buffer its converters were not built for, it must say
/// so rather than record the failure and fall silent.
///
/// What cannot be checked here is the other half — that AVFoundation
/// really does post that notification when the audio route changes, and
/// that the engine really does stop itself when it does. Only hardware can
/// show that, and the manual checklist in this package's README is where
/// it is checked.

private actor ReportedReasons {
    private(set) var reasons: [String] = []

    func record(_ reason: String) {
        reasons.append(reason)
    }
}

private func waitUntil(
    timeout: TimeInterval = 2,
    _ condition: @Sendable () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return await condition()
}

/// Long enough for a report that should never arrive to have arrived: the
/// reporter hands each one to a detached task, so "nothing was reported"
/// can only be observed by letting one run first.
private func allowAnyPendingReport() async {
    try? await Task.sleep(nanoseconds: 50_000_000)
}

private func connect(_ reporter: LiveAudioFailureReporter) -> ReportedReasons {
    let reasons = ReportedReasons()
    reporter.connect { await reasons.record($0) }
    return reasons
}

@Test func aConfigurationChangeIsReportedAsAChangedAudioRoute() async {
    let engine = NSObject()
    let reporter = LiveAudioFailureReporter()
    let reasons = connect(reporter)
    reporter.observeConfigurationChanges(of: engine)

    NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)

    #expect(
        await waitUntil { await reasons.reasons == ["audio_route_changed"] },
        "a route change must reach the coordinator as its own wire code, not as a silent stop"
    )
    reporter.invalidate()
}

@Test func aConfigurationChangeForAnotherObjectIsIgnored() async {
    let engine = NSObject()
    let reporter = LiveAudioFailureReporter()
    let reasons = connect(reporter)
    reporter.observeConfigurationChanges(of: engine)

    NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: NSObject())

    await allowAnyPendingReport()
    #expect(await reasons.reasons.isEmpty, "only this session's own engine may end this session")
    reporter.invalidate()
}

@Test func onlyTheFirstFailureOfASessionIsReported() async {
    let reporter = LiveAudioFailureReporter()
    let reasons = connect(reporter)

    reporter.report("narration_write_failed")
    reporter.report("recogniser_failed")

    #expect(await waitUntil { await reasons.reasons.count == 1 })
    await allowAnyPendingReport()
    #expect(
        await reasons.reasons == ["narration_write_failed"],
        "one failure ends the session, and the panel shows the reason that ended it"
    )
    reporter.invalidate()
}

@Test func nothingIsReportedOnceTheSessionIsTornDown() async {
    let engine = NSObject()
    let reporter = LiveAudioFailureReporter()
    let reasons = connect(reporter)
    reporter.observeConfigurationChanges(of: engine)

    reporter.invalidate()
    reporter.report("recogniser_failed")
    NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)

    await allowAnyPendingReport()
    #expect(
        await reasons.reasons.isEmpty,
        "tearing the session down is what stops the engine and ends the analyser's stream: neither is a failure"
    )
}

/// A buffer in a format neither of the tap's converters was built for.
/// `AVAudioConverter` rejects it — cleanly, with an error, which is what
/// makes this a usable stand-in for the real thing: an encoder that cannot
/// take what the hardware is giving it fails on every buffer, for the
/// length of the recording.
@available(macOS 26, *)
private func makeTapFedTheWrongFormat(
    reporter: LiveAudioFailureReporter,
    directory: URL
) throws -> MicrophoneTap {
    let tapFormat = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
    let analyzerFormat = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
    // Only the continuation is kept. Nothing here may ever construct an
    // `AnalyzerInput`: doing so traps in this process, which is why the
    // buffer below is one both converters reject — a rejected buffer is
    // never handed to the analyser — and why this tap is never asked to
    // finish its analyser input, whose flush would build one.
    let (_, analyzerInput) = AsyncStream<AnalyzerInput>.makeStream()
    let tap = try MicrophoneTap(
        // An origin in the future, so `receive` asks for no leading
        // silence: this test is about the failure, not about the seconds
        // of AAC that would otherwise be encoded first.
        captureOriginUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds &+ 60_000_000_000,
        audioURL: directory.appendingPathComponent("audio.m4a"),
        tapFormat: tapFormat,
        analyzerFormat: analyzerFormat,
        analyzerInput: analyzerInput,
        failureReporter: reporter
    )
    let wrongFormat = try #require(AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: wrongFormat, frameCapacity: 1_024))
    buffer.frameLength = 1_024
    // `AVAudioTime(sampleTime:atRate:)` carries no host time, so `receive`
    // reads the clock itself, as it does for a tap buffer that arrives
    // without one.
    tap.receive(buffer, at: AVAudioTime(sampleTime: 0, atRate: 44_100))
    return tap
}

@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func aTapThatCannotConvertWhatTheMicrophoneGivesItSaysSo() async throws {
    guard #available(macOS 26, *) else { return }
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("replay-tap-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let reporter = LiveAudioFailureReporter()
    let reasons = connect(reporter)
    let tap = try makeTapFedTheWrongFormat(reporter: reporter, directory: directory)

    #expect(
        await waitUntil { await reasons.reasons == ["narration_write_failed"] },
        "a narration conversion that fails must reach the coordinator, not just be recorded and forgotten"
    )
    // The same buffer fails the analyser's converter too — both are built
    // from the one tap format, so no buffer can fail one and not the other
    // — and its report is enqueued behind narration's on the same serial
    // queue. The session is told once, by the first to arrive.
    await allowAnyPendingReport()
    #expect(await reasons.reasons.count == 1, "one failure ends the session; the second site must not report again")

    tap.closeNarration()
}

@Test func anInstalledObserverDoesNotKeepTheReporterAlive() {
    let engine = NSObject()
    weak var released: LiveAudioFailureReporter?
    autoreleasepool {
        let reporter = LiveAudioFailureReporter()
        reporter.observeConfigurationChanges(of: engine)
        released = reporter
    }

    #expect(
        released == nil,
        "NotificationCenter retains the observer's block, so the block must not reach back to the reporter strongly"
    )
}
