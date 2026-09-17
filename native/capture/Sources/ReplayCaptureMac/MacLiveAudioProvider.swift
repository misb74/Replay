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

/// Owns the speech model's installation state, and builds one live session
/// per recording.
///
/// The three things it needs from the Speech framework are injected, so the
/// state machine below can be tested on its own. `makeLiveAudioProvider()`
/// always supplies the real ones.
@available(macOS 26, *)
final class MacLiveAudioProvider: LiveAudioProviding, @unchecked Sendable {
    /// Resolves a requested locale identifier to one the on-device
    /// transcriber supports, or throws if there is none.
    typealias LocaleResolver = @Sendable (String?) async throws -> Locale
    /// Whether the model for a locale is installed, downloading, merely
    /// supported, or not supported at all.
    typealias StatusReader = @Sendable (Locale) async -> AssetInventory.Status
    /// Installs the model for a locale, reporting whether there was
    /// anything to install. False means the system had nothing to fetch.
    typealias Installer = @Sendable (Locale) async throws -> Bool

    private let resolveLocale: LocaleResolver
    private let status: StatusReader
    private let install: Installer

    /// At most one installation per resolved locale, the failure an
    /// installation left behind if it threw, and how many installations in
    /// a row found nothing to install and changed nothing. Guarded by a
    /// lock rather than actor isolation so that "is one already running?"
    /// is asked and acted on in the same uninterrupted stretch.
    private let lock = NSLock()
    private var installations: [String: Task<Void, Error>] = [:]
    private var unreportedFailures: [String: Error] = [:]
    private var emptyInstallations: [String: Int] = [:]

    init(
        resolveLocale: @escaping LocaleResolver = { try await MacLiveAudioProvider.supportedLocale(for: $0) },
        status: @escaping StatusReader = { await MacLiveAudioProvider.installationStatus(for: $0) },
        install: @escaping Installer = { try await MacLiveAudioProvider.installModel(for: $0) }
    ) {
        self.resolveLocale = resolveLocale
        self.status = status
        self.install = install
    }

    func prepare(locale: String?) async throws -> LivePreparation {
        let resolved = try await resolveLocale(locale)
        let identifier = resolved.identifier

        // Report a previous failure before looking at anything else, and
        // only once: this call throws, and the call after it finds nothing
        // recorded and starts a fresh installation.
        if let failure = lock.replayWithLock({ unreportedFailures.removeValue(forKey: identifier) }) {
            throw failure
        }

        switch await status(resolved) {
        case .installed:
            lock.replayWithLock { emptyInstallations[identifier] = nil }
            return .ready
        case .unsupported:
            // The locale resolver already filtered the locale itself, so
            // this means the assets cannot be had on this Mac.
            throw SidecarOperationError.unsupported(Self.unsupportedMessage(for: resolved))
        case .supported, .downloading:
            // `.downloading` can mean an installation this process never
            // started — another app's, or an earlier run's. Asking again is
            // safe: the SDK documents that the system consolidates download
            // and installation requests without downloading anything twice.
            break
        @unknown default:
            break
        }

        // An installation that finds nothing to install, and yet leaves the
        // model uninstalled, will get no further however often it is
        // repeated. One can legitimately race a status read; a second in a
        // row means the assets are not coming, and answering `.preparing`
        // for ever would leave the panel waiting for good.
        let exhausted: Bool = lock.replayWithLock {
            guard installations[identifier] == nil,
                  (emptyInstallations[identifier] ?? 0) >= 2 else { return false }
            emptyInstallations[identifier] = nil
            return true
        }
        if exhausted {
            throw SidecarOperationError.unsupported(Self.unavailableMessage(for: resolved))
        }

        startInstallingIfNeeded(resolved, identifier: identifier)
        return .preparing
    }

    func makeSession(
        configuration: LiveAudioStartConfiguration,
        eventSink: @escaping @Sendable (SidecarLiveEventEnvelope) async -> Void
    ) async throws -> LiveAudioControlling {
        let transcriber = try await requireInstalledModel(locale: configuration.locale)
        let engine = MacLiveAudioEngine(
            configuration: configuration,
            transcriber: transcriber
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

    /// The check `makeSession` makes before it builds anything, and the
    /// reason it never downloads: a recording must not stall behind a
    /// first-run model download, so the sidecar refuses to start one until
    /// `prepare(locale:)` has reported `.ready`.
    ///
    /// Split out so it can be tested directly. A test that drove
    /// `makeSession` far enough to discover this check missing would go on
    /// to build a real audio engine and open the microphone, which this
    /// suite must never do.
    func requireInstalledModel(locale: String?) async throws -> SpeechTranscriber {
        let resolved = try await resolveLocale(locale)
        guard await status(resolved) == .installed else {
            throw SidecarOperationError.invalidState("The speech model is not ready yet.")
        }
        return Self.makeTranscriber(for: resolved)
    }

    /// Waits for any installation in flight to finish. Tests only — lets a
    /// test observe what one left behind without sleeping for it.
    func drainInstallationsForTesting() async {
        let running = lock.replayWithLock { Array(installations.values) }
        for installation in running {
            _ = try? await installation.value
        }
    }

    private func startInstallingIfNeeded(_ locale: Locale, identifier: String) {
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
            guard let self else { return }
            do {
                let requestedDownload = try await self.install(locale)
                self.finishInstalling(
                    identifier: identifier,
                    requestedDownload: requestedDownload,
                    failure: nil
                )
            } catch {
                self.finishInstalling(identifier: identifier, requestedDownload: false, failure: error)
                throw error
            }
        }
        installations[identifier] = installation
        lock.unlock()
    }

    private func finishInstalling(identifier: String, requestedDownload: Bool, failure: Error?) {
        lock.replayWithLock {
            installations.removeValue(forKey: identifier)
            if let failure {
                unreportedFailures[identifier] = failure
                emptyInstallations[identifier] = nil
            } else if requestedDownload {
                emptyInstallations[identifier] = nil
            } else {
                emptyInstallations[identifier, default: 0] += 1
            }
        }
    }

    // MARK: The real Speech framework

    private static func supportedLocale(for locale: String?) async throws -> Locale {
        let requested = locale.map(Locale.init(identifier:)) ?? Locale.current
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
            throw SidecarOperationError.unsupported(unsupportedMessage(for: requested))
        }
        return supported
    }

    private static func installationStatus(for locale: Locale) async -> AssetInventory.Status {
        await AssetInventory.status(forModules: [makeTranscriber(for: locale)])
    }

    private static func installModel(for locale: Locale) async throws -> Bool {
        // Reserving the locale is not a step of its own: the SDK documents
        // that `AssetInventory` assigns the app's asset reservations to the
        // locale automatically when an installation request needs it.
        guard let request = try await AssetInventory.assetInstallationRequest(
            supporting: [makeTranscriber(for: locale)]
        ) else {
            // Nothing to install: the assets were preinstalled, or another
            // app or an earlier call already fetched them.
            return false
        }
        try await request.downloadAndInstall()
        return true
    }

    /// Modules are configuration, not identity — the SDK installs assets
    /// from a module's settings rather than the object — so every one of
    /// these describes the same model.
    private static func makeTranscriber(for locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
    }

    private static func unsupportedMessage(for locale: Locale) -> String {
        "Live speech recognition is not available for \(locale.identifier) on this Mac."
    }

    private static func unavailableMessage(for locale: Locale) -> String {
        "The speech model for \(locale.identifier) could not be installed on this Mac."
    }
}
