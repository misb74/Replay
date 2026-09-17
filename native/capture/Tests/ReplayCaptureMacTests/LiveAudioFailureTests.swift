import AVFoundation
import Foundation
import Testing
@testable import ReplayCaptureMac

/// `LiveAudioFailureReporter` is the one path a live audio failure takes
/// from wherever it is noticed to the coordinator. It is a lock, a handler
/// and a notification observer: nothing here builds an `AVAudioEngine`,
/// opens the microphone or makes a sound, and
/// `AVAudioEngineConfigurationChange` is only a name, which any object can
/// be the subject of.
///
/// What cannot be checked here is the other half — that AVFoundation
/// really does post that notification when the audio route changes, and
/// that the engine really does stop itself when it does. Only hardware can
/// show that; see the task report for what to watch for.

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
