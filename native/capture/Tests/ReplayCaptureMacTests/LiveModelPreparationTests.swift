import Foundation
import ReplayCaptureCore
import Testing
@testable import ReplayCaptureMac

/// `MacLiveAudioProvider` opens no microphone and makes no sound: it only
/// decides when the on-device speech model is ready. Its three dealings
/// with the Speech framework are injected, so these drive the state machine
/// directly and never reach `AssetInventory` or build an audio engine.

private actor CallCounter {
    private(set) var count = 0

    func increment() {
        count += 1
    }
}

/// Holds whoever waits on it until the test lets them go, so a test can
/// observe what happens *while* an installation is still running rather
/// than racing it.
private actor Gate {
    private var released = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !released else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiting.append(continuation)
        }
    }

    func release() {
        released = true
        let resuming = waiting
        waiting.removeAll()
        for continuation in resuming { continuation.resume() }
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

@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func anInstalledModelIsReadyAtOnce() async throws {
    guard #available(macOS 26, *) else { return }
    let installs = CallCounter()
    let provider = MacLiveAudioProvider(
        resolveLocale: { _ in Locale(identifier: "en-GB") },
        status: { _ in .installed },
        install: { _ in await installs.increment(); return true }
    )

    let preparation = try await provider.prepare(locale: nil)

    #expect(preparation == .ready)
    #expect(await installs.count == 0, "an installed model needs no installation")
}

@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func anUnsupportedModelIsReportedRatherThanInstalled() async throws {
    guard #available(macOS 26, *) else { return }
    let installs = CallCounter()
    let provider = MacLiveAudioProvider(
        resolveLocale: { _ in Locale(identifier: "en-GB") },
        status: { _ in .unsupported },
        install: { _ in await installs.increment(); return true }
    )

    await #expect(throws: SidecarOperationError.self) {
        _ = try await provider.prepare(locale: nil)
    }
    #expect(await installs.count == 0)
}

@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func prepareStartsOneInstallationPerLocaleAndDoesNotWaitForIt() async throws {
    guard #available(macOS 26, *) else { return }
    let entered = CallCounter()
    let gate = Gate()
    let provider = MacLiveAudioProvider(
        resolveLocale: { _ in Locale(identifier: "en-GB") },
        status: { _ in .supported },
        install: { _ in
            await entered.increment()
            await gate.wait()
            return true
        }
    )

    // Returns while the installation is still held inside the gate: a
    // first-run download must not block the answer.
    let first = try await provider.prepare(locale: nil)
    #expect(first == .preparing)
    #expect(await waitUntil { await entered.count == 1 }, "the installation must actually have been started")

    // Two more asks, both landing while that installation is still
    // running, and one of them naming the locale explicitly rather than
    // taking the default. Each joins the running installation.
    let second = try await provider.prepare(locale: nil)
    let third = try await provider.prepare(locale: "en-GB")
    #expect(second == .preparing)
    #expect(third == .preparing)

    await gate.release()
    await provider.drainInstallationsForTesting()

    #expect(await entered.count == 1, "one installation per locale, however often prepare is asked")
}

@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func concurrentPreparesStartOnlyOneInstallation() async throws {
    guard #available(macOS 26, *) else { return }
    let entered = CallCounter()
    let gate = Gate()
    let provider = MacLiveAudioProvider(
        resolveLocale: { _ in Locale(identifier: "en-GB") },
        status: { _ in .supported },
        install: { _ in
            await entered.increment()
            await gate.wait()
            return true
        }
    )

    async let first = provider.prepare(locale: nil)
    async let second = provider.prepare(locale: nil)
    async let third = provider.prepare(locale: nil)
    let results = try await [first, second, third]

    #expect(results == [.preparing, .preparing, .preparing])
    await gate.release()
    await provider.drainInstallationsForTesting()
    #expect(await entered.count == 1, "three overlapping asks must not become three downloads")
}

@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func anInstallationFailureIsReportedOnceAndTheNextCallTriesAgain() async throws {
    guard #available(macOS 26, *) else { return }
    let attempts = CallCounter()
    let provider = MacLiveAudioProvider(
        resolveLocale: { _ in Locale(identifier: "en-GB") },
        status: { _ in .supported },
        install: { _ in
            await attempts.increment()
            throw SidecarOperationError.captureFailed
        }
    )

    let started = try await provider.prepare(locale: nil)
    #expect(started == .preparing)
    await provider.drainInstallationsForTesting()
    #expect(await attempts.count == 1)

    await #expect(throws: SidecarOperationError.captureFailed) {
        _ = try await provider.prepare(locale: nil)
    }

    // Reported once. The call after it starts a fresh attempt rather than
    // throwing the same failure for the rest of the session.
    let retried = try await provider.prepare(locale: nil)
    #expect(retried == .preparing)
    await provider.drainInstallationsForTesting()
    #expect(await attempts.count == 2)
}

@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func installationsThatFindNothingToInstallStopAnsweringPreparingForever() async throws {
    guard #available(macOS 26, *) else { return }
    let attempts = CallCounter()
    let provider = MacLiveAudioProvider(
        resolveLocale: { _ in Locale(identifier: "en-GB") },
        status: { _ in .supported },
        install: { _ in
            // Nothing to install, and the model stays uninstalled: asking
            // again will never get anywhere.
            await attempts.increment()
            return false
        }
    )

    for _ in 0..<2 {
        let preparation = try await provider.prepare(locale: nil)
        #expect(preparation == .preparing)
        await provider.drainInstallationsForTesting()
    }
    #expect(await attempts.count == 2)

    await #expect(throws: SidecarOperationError.self) {
        _ = try await provider.prepare(locale: nil)
    }
    #expect(
        await attempts.count == 2,
        "a third installation that could only find nothing again must not be started, and the panel must not be left waiting for good"
    )
}

/// `requireInstalledModel` is everything `makeSession` does before it
/// builds anything. Tested here rather than through `makeSession` itself:
/// a test that drove `makeSession` far enough to find this check missing
/// would go on to build a real audio engine and open the microphone, which
/// this suite must never do.
@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func makeSessionsModelCheckRefusesWithoutDownloadingAnything() async throws {
    guard #available(macOS 26, *) else { return }
    let installs = CallCounter()
    let provider = MacLiveAudioProvider(
        resolveLocale: { _ in Locale(identifier: "en-GB") },
        status: { _ in .supported },
        install: { _ in await installs.increment(); return true }
    )

    await #expect(throws: SidecarOperationError.invalidState("The speech model is not ready yet.")) {
        _ = try await provider.requireInstalledModel(locale: nil)
    }
    #expect(await installs.count == 0, "starting a recording must never begin a download; only prepare() may")
}

@Test(.enabled(if: liveAudioIsAvailableOnThisSystem))
func makeSessionsModelCheckPassesOnceTheModelIsInstalled() async throws {
    guard #available(macOS 26, *) else { return }
    let installs = CallCounter()
    let provider = MacLiveAudioProvider(
        resolveLocale: { _ in Locale(identifier: "en-GB") },
        status: { _ in .installed },
        install: { _ in await installs.increment(); return true }
    )

    _ = try await provider.requireInstalledModel(locale: nil)

    #expect(await installs.count == 0)
}
