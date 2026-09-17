import AVFoundation
import Foundation

/// The one path a live audio failure takes from wherever it is noticed to
/// the coordinator, which is the only thing that can tell the panel.
///
/// A failure is noticed in places that cannot simply await the
/// coordinator: AVFoundation's notification queue, the narration queue,
/// the results loop, and the engine's own `speak(_:utteranceId:)` — which
/// runs inside the coordinator's drain loop, the very thing
/// `reportFailure(reason:)` waits for, so awaiting it from there would
/// deadlock. So `report(_:)` never blocks and never awaits: it hands the
/// reason to a detached task and returns.
///
/// It reports the first failure of a session and ignores the rest. One
/// failure ends the tutor, and the panel shows the reason that ended it.
///
/// Separate from `MacLiveAudio.swift`, which is already long, because this
/// is the one part of the Mac audio side that can be tested with no audio
/// hardware at all — see `LiveAudioFailureTests`.
final class LiveAudioFailureReporter: @unchecked Sendable {
    /// Reports one failure by its wire code: `audio_route_changed`,
    /// `audio_engine_stopped`, `recogniser_failed` or
    /// `narration_write_failed`.
    typealias Handler = @Sendable (String) async -> Void

    private let lock = NSLock()
    /// One operation at a time, and never the thread that posted the
    /// notification: `AVAudioEngine.h` says of the configuration change
    /// that "the callback happens on an internal dispatch queue and can
    /// deadlock while trying to synchronously teardown the engine", which
    /// is exactly what reporting a failure goes on to do.
    private let notificationQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "Replay live audio failures"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private var handler: Handler?
    private var observer: NSObjectProtocol?
    private var reported = false
    /// Read by `observeConfigurationChanges(of:)` alone, to catch a
    /// teardown that lands while an observer is being installed. Nothing
    /// else needs it: `invalidate()` releases the handler, and `report(_:)`
    /// has nothing to report through without one.
    private var invalidated = false

    /// Points this reporter at the coordinator, before the session starts,
    /// so a failure during start-up is reported rather than lost.
    ///
    /// The handler must hold the coordinator weakly: the coordinator owns
    /// the engine, which owns this, so a strong reference here would keep
    /// a finished session alive for good.
    func connect(_ handler: @escaping Handler) {
        lock.replayWithLock { self.handler = handler }
    }

    /// Reports `reason` unless this session has already failed, or is
    /// being torn down — which `invalidate()` says by clearing the
    /// handler. Returns immediately: the coordinator is told from a
    /// detached task, which inherits no actor context, so the teardown
    /// that follows never runs on whatever noticed the failure.
    func report(_ reason: String) {
        let connected: Handler? = lock.replayWithLock {
            guard !reported, let handler else { return nil }
            reported = true
            return handler
        }
        guard let connected else { return }
        Task.detached { await connected(reason) }
    }

    /// Starts watching `engine` for the configuration change AVFoundation
    /// posts when the audio hardware's channel count or sample rate
    /// changes — a Bluetooth device connecting, an input device at a
    /// different rate being selected, a display with speakers waking.
    /// `AVAudioEngine.h`: "the engine stops itself (see
    /// `AVAudioEngine(stop)`), and issues this notification".
    ///
    /// It is the format that matters, not the socket: plugging in analogue
    /// headphones only qualifies if it changes the channel count or the
    /// sample rate, which depends on the Mac and on what the device
    /// reports. The manual checklist in this package's README says the
    /// same, and asks for a device that certainly does change one.
    ///
    /// Called once per session, as its engine starts: one reporter belongs
    /// to one engine, and that engine is started once.
    ///
    /// This version does not rebuild the engine around the new hardware.
    /// It fails visibly instead, so that the panel stops saying it is
    /// listening at the moment it stops hearing anything. Rebuilding would
    /// mean re-deriving every format, re-installing the tap and splicing
    /// `audio.m4a` back together across the gap, which is its own task.
    ///
    /// The block captures this reporter weakly. `NotificationCenter`
    /// retains the block and this reporter retains the token it hands
    /// back, so a strong capture would be a cycle, and the observer would
    /// outlive the session that installed it.
    func observeConfigurationChanges(of engine: AnyObject) {
        let token = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: notificationQueue
        ) { [weak self] _ in
            self?.report("audio_route_changed")
        }
        let alreadyInvalidated = lock.replayWithLock { () -> Bool in
            guard !invalidated else { return true }
            observer = token
            return false
        }
        // A teardown that landed while the observer was being installed
        // would otherwise leave it registered for the life of the process.
        if alreadyInvalidated { NotificationCenter.default.removeObserver(token) }
    }

    /// Stops this session reporting anything more, and removes the
    /// observer. Called as soon as a stop is asked for: from then on the
    /// engine stopping, the analyser's stream ending and the narration
    /// file closing are all how a session ends, not why it failed.
    ///
    /// Releasing the handler is what silences `report(_:)`, and it also
    /// releases the coordinator this reporter was pointed at.
    func invalidate() {
        let token: NSObjectProtocol? = lock.replayWithLock {
            invalidated = true
            handler = nil
            let installed = observer
            observer = nil
            return installed
        }
        if let token { NotificationCenter.default.removeObserver(token) }
    }

    deinit {
        // A backstop for a session that is released without being stopped:
        // an observer must never outlive the object it reports through.
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}
