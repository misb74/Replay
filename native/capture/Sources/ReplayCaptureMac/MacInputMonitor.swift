import AppKit
import CoreGraphics
import Foundation
import ReplayCaptureCore

public final class MacInputMonitor: InputMonitoring, @unchecked Sendable {
    private struct MouseGesture {
        var start: CGPoint
        var button: MouseButton
        var dragged: Bool
    }

    private let lock = NSLock()
    private let runLoopGroup = DispatchGroup()
    private var handler: InputEventHandler?
    private var sessionId = ""
    private var startedAtNanos: UInt64 = 0
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private var workspaceObserver: NSObjectProtocol?
    private var deliveryTail: Task<Void, Never>?
    private var gesture: MouseGesture?
    private var lastBundleId: String?
    private var lastWindowTitle: String?
    private var lastRecordedProcessId: Int32?
    private var excludedProcessIds: Set<Int32> = []

    public init() {}

    public func start(
        sessionId: String,
        startedAtUptimeNanoseconds: UInt64,
        excludeProcessIds: [Int32],
        handler: @escaping InputEventHandler
    ) async throws {
        let alreadyRunning = lock.replayWithLock {
            let running = tap != nil || thread != nil
            if !running {
                self.sessionId = sessionId
                self.startedAtNanos = startedAtUptimeNanoseconds
                self.excludedProcessIds = Set(excludeProcessIds)
                self.handler = handler
            }
            return running
        }
        guard !alreadyRunning else {
            throw SidecarOperationError.invalidState("Input monitoring is already active.")
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let runLoopGroup = self.runLoopGroup
            runLoopGroup.enter()
            let thread = Thread { [weak self] in
                defer { runLoopGroup.leave() }
                guard let self else {
                    continuation.resume(throwing: SidecarOperationError.captureFailed)
                    return
                }

                let mask = Self.eventMask
                guard let tap = CGEvent.tapCreate(
                    tap: .cgSessionEventTap,
                    place: .headInsertEventTap,
                    options: .listenOnly,
                    eventsOfInterest: mask,
                    callback: Self.eventTapCallback,
                    userInfo: Unmanaged.passUnretained(self).toOpaque()
                ) else {
                    self.clearState()
                    continuation.resume(throwing: SidecarOperationError.permissionDenied(.inputMonitoring))
                    return
                }

                let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
                let runLoop = CFRunLoopGetCurrent()
                self.lock.lock()
                self.tap = tap
                self.runLoop = runLoop
                self.lock.unlock()

                let observer = NSWorkspace.shared.notificationCenter.addObserver(
                    forName: NSWorkspace.didActivateApplicationNotification,
                    object: nil,
                    queue: nil
                ) { [weak self] notification in
                    self?.applicationActivated(notification)
                }
                self.lock.replayWithLock { self.workspaceObserver = observer }

                CFRunLoopAddSource(runLoop, source, .commonModes)
                CGEvent.tapEnable(tap: tap, enable: true)
                continuation.resume()
                CFRunLoopRun()
                CGEvent.tapEnable(tap: tap, enable: false)
                CFRunLoopRemoveSource(runLoop, source, .commonModes)
                NSWorkspace.shared.notificationCenter.removeObserver(observer)
                self.clearState()
            }
            thread.name = "Replay input monitor"
            lock.lock()
            self.thread = thread
            lock.unlock()
            thread.start()
        }
    }

    public func stop() async {
        let state = lock.replayWithLock {
            let current = self.runLoop
            handler = nil
            return (current, deliveryTail)
        }
        if let runLoop = state.0 {
            CFRunLoopStop(runLoop)
        } else {
            clearState()
        }
        if let deliveryTail = state.1 {
            await deliveryTail.value
        }
        await withCheckedContinuation { continuation in
            runLoopGroup.notify(queue: .global(qos: .userInitiated)) {
                continuation.resume()
            }
        }
    }

    private static let eventMask: CGEventMask = {
        let types: [CGEventType] = [
            .keyDown,
            .leftMouseDown, .leftMouseDragged, .leftMouseUp,
            .rightMouseDown, .rightMouseDragged, .rightMouseUp,
            .otherMouseDown, .otherMouseDragged, .otherMouseUp,
            .scrollWheel
        ]
        return types.reduce(CGEventMask(0)) { partial, type in
            partial | (CGEventMask(1) << CGEventMask(type.rawValue))
        }
    }()

    private static let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let monitor = Unmanaged<MacInputMonitor>.fromOpaque(userInfo).takeUnretainedValue()

        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            monitor.enableTap()
            return Unmanaged.passUnretained(event)
        }

        monitor.process(type: type, event: event)
        return Unmanaged.passUnretained(event)
    }

    private func process(type: CGEventType, event: CGEvent) {
        if event.getIntegerValueField(.eventSourceUserData) == replaySyntheticEventMarker {
            return
        }
        let state: (String, UInt64, Bool, Set<Int32>) = lock.replayWithLock {
            (self.sessionId, self.startedAtNanos, self.handler != nil, self.excludedProcessIds)
        }
        let sessionId = state.0
        let startedAtNanos = state.1
        guard state.2 else { return }
        let excludedProcessIds = state.3

        // Key events are delivered to the frontmost application; every other
        // event tracked here carries its own target process id. Either is
        // read before the accessibility snapshot below, so an excluded
        // process's UI (Replay's own live-tutor panel, say) is never
        // inspected at all.
        let targetProcessId: Int32
        switch type {
        case .keyDown:
            targetProcessId = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        default:
            targetProcessId = Int32(event.getIntegerValueField(.eventTargetUnixProcessID))
        }
        guard shouldRecordInput(targetProcessId: targetProcessId, excluded: excludedProcessIds) else {
            return
        }
        // The switch-back decision in `applicationActivated` compares
        // against this, so it must track the process id of every event
        // actually recorded here — never a value derived from accessibility
        // data, which can be briefly unreadable. `targetProcessId` can
        // itself be 0 (unknown, e.g. no frontmost application reported for
        // a key event); `nextRecordedProcessId` keeps the current tracked
        // pid rather than overwriting it with that meaningless value.
        lock.replayWithLock {
            lastRecordedProcessId = nextRecordedProcessId(
                current: lastRecordedProcessId,
                targetProcessId: targetProcessId
            )
        }

        let eventNanos = event.timestamp
        let timestampMs = Double(eventNanos >= startedAtNanos ? eventNanos - startedAtNanos : 0) / 1_000_000
        let point = event.location
        let target: AccessibilityTarget?
        switch type {
        case .keyDown:
            target = MacAccessibility.snapshot(at: nil)
        default:
            target = MacAccessibility.snapshot(at: point)
        }

        emitContextChanges(
            target: target,
            sessionId: sessionId,
            timestampMs: timestampMs
        )

        let raw: RawInputEvent?
        switch type {
        case .keyDown:
            raw = .key(
                id: UUID().uuidString,
                sessionId: sessionId,
                timestampMs: timestampMs,
                keyCode: UInt16(event.getIntegerValueField(.keyboardEventKeycode)),
                text: keyboardText(from: event),
                modifiers: modifierKeys(from: event.flags)
            )
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            gesture = MouseGesture(start: point, button: mouseButton(for: type), dragged: false)
            raw = nil
        case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            gesture?.dragged = true
            raw = nil
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            let current = gesture
            gesture = nil
            if let current, current.dragged {
                raw = .drag(
                    id: UUID().uuidString,
                    sessionId: sessionId,
                    timestampMs: timestampMs,
                    start: Point(x: current.start.x, y: current.start.y),
                    end: Point(x: point.x, y: point.y),
                    button: current.button
                )
            } else {
                raw = .click(
                    id: UUID().uuidString,
                    sessionId: sessionId,
                    timestampMs: timestampMs,
                    position: Point(x: point.x, y: point.y),
                    button: current?.button ?? mouseButton(for: type),
                    clickCount: max(1, Int(event.getIntegerValueField(.mouseEventClickState)))
                )
            }
        case .scrollWheel:
            raw = .scroll(
                id: UUID().uuidString,
                sessionId: sessionId,
                timestampMs: timestampMs,
                position: Point(x: point.x, y: point.y),
                deltaX: event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2),
                deltaY: event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
            )
        default:
            raw = nil
        }

        if let raw {
            schedule(raw, target: target)
        }
    }

    private func emitContextChanges(
        target: AccessibilityTarget?,
        sessionId: String,
        timestampMs: Double
    ) {
        let changes: (app: Bool, window: Bool) = lock.replayWithLock {
            var appChanged = false
            var windowChanged = false
            if let bundleId = target?.bundleId, bundleId != lastBundleId {
                lastBundleId = bundleId
                appChanged = true
            }
            if let title = target?.windowTitle, title != lastWindowTitle {
                lastWindowTitle = title
                windowChanged = true
            }
            return (appChanged, windowChanged)
        }
        if changes.app {
            schedule(.appSwitch(
                id: UUID().uuidString,
                sessionId: sessionId,
                timestampMs: timestampMs
            ), target: target)
        }
        if changes.window {
            schedule(.windowSwitch(
                id: UUID().uuidString,
                sessionId: sessionId,
                timestampMs: timestampMs
            ), target: target)
        }
    }

    private func applicationActivated(_ notification: Notification) {
        let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
            as? NSRunningApplication
        let activatedProcessId = application?.processIdentifier ?? 0

        let state: (String, UInt64, Bool, Set<Int32>) = lock.replayWithLock {
            (self.sessionId, self.startedAtNanos, self.handler != nil, self.excludedProcessIds)
        }
        guard state.2 else { return }
        guard shouldRecordInput(targetProcessId: activatedProcessId, excluded: state.3) else {
            // Excluded: no accessibility snapshot of Replay's own UI, and the
            // last-recorded context is left exactly as it was.
            return
        }
        // Captured before the accessibility snapshot below, which can take a
        // little while, so the timestamp still reflects the activation
        // itself rather than how long that lookup took.
        let now = DispatchTime.now().uptimeNanoseconds
        let timestampMs = Double(now >= state.1 ? now - state.1 : 0) / 1_000_000

        var target = MacAccessibility.snapshot(at: nil) ?? AccessibilityTarget()
        if let bundleId = application?.bundleIdentifier {
            target.bundleId = bundleId
        }

        let recorded: Bool = lock.replayWithLock {
            // Decided by process id alone: an accessibility read can race
            // the window becoming readable and return a nil title exactly
            // at activation, and nil must never be able to invent or hide a
            // switch the way a bundle id/title comparison would.
            let shouldRecord = shouldRecordAppSwitch(
                activatedProcessId: activatedProcessId,
                lastRecordedProcessId: lastRecordedProcessId,
                excluded: state.3
            )
            if shouldRecord {
                lastBundleId = target.bundleId
                lastWindowTitle = target.windowTitle
                lastRecordedProcessId = activatedProcessId
            }
            return shouldRecord
        }
        guard recorded else { return }

        schedule(.appSwitch(
            id: UUID().uuidString,
            sessionId: state.0,
            timestampMs: timestampMs
        ), target: target)
    }

    private func schedule(_ event: RawInputEvent, target: AccessibilityTarget?) {
        lock.replayWithLock {
            guard let handler else { return }
            let previous = deliveryTail
            deliveryTail = Task {
                if let previous {
                    await previous.value
                }
                await handler(event, target)
            }
        }
    }

    private func keyboardText(from event: CGEvent) -> String? {
        var count = 0
        var characters = [UniChar](repeating: 0, count: 64)
        event.keyboardGetUnicodeString(
            maxStringLength: characters.count,
            actualStringLength: &count,
            unicodeString: &characters
        )
        guard count > 0 else { return nil }
        return String(utf16CodeUnits: characters, count: count)
    }

    private func modifierKeys(from flags: CGEventFlags) -> [ModifierKey] {
        var result: [ModifierKey] = []
        if flags.contains(.maskCommand) { result.append(.command) }
        if flags.contains(.maskControl) { result.append(.control) }
        if flags.contains(.maskAlternate) { result.append(.option) }
        if flags.contains(.maskShift) { result.append(.shift) }
        if flags.contains(.maskAlphaShift) { result.append(.capsLock) }
        if flags.contains(.maskSecondaryFn) { result.append(.function) }
        return result
    }

    private func mouseButton(for type: CGEventType) -> MouseButton {
        switch type {
        case .rightMouseDown, .rightMouseDragged, .rightMouseUp: return .right
        case .otherMouseDown, .otherMouseDragged, .otherMouseUp: return .other
        default: return .left
        }
    }

    private func enableTap() {
        let tap = lock.replayWithLock { self.tap }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
    }

    private func clearState() {
        lock.replayWithLock {
            handler = nil
            tap = nil
            runLoop = nil
            thread = nil
            workspaceObserver = nil
            deliveryTail = nil
            gesture = nil
            lastBundleId = nil
            lastWindowTitle = nil
            lastRecordedProcessId = nil
            excludedProcessIds = []
        }
    }
}

/// Whether an input event aimed at `targetProcessId` belongs in the
/// recording. Matching is by process id only: in development every Electron
/// app — Replay included — reports the same bundle id, so filtering on
/// bundle id would also drop the user's real input in other Electron apps
/// such as Slack or VS Code. A `targetProcessId` of zero or less means the
/// target process could not be determined; it is never in `excluded` (real
/// excluded ids are always positive), so unresolvable input is still
/// recorded rather than silently dropped.
func shouldRecordInput(targetProcessId: Int32, excluded: Set<Int32>) -> Bool {
    !excluded.contains(targetProcessId)
}

/// Whether an application activation should be recorded as an `app_switch`.
/// A process id of zero or less is unknown — the activation could not be
/// resolved to a running application — and carries no signal, so it is
/// always dropped without changing anything. An activation aimed at an
/// excluded process is also always dropped. Otherwise, an activation of the
/// process already recorded as current is not a genuine switch: without
/// this check, the user's return from an excluded activation (Replay's own
/// live-tutor panel, say) to the application already being recorded would
/// be misreported as a fresh switch, because the excluded activation never
/// updated the last-recorded process in the first place. The same check is
/// correct when nothing is excluded at all.
///
/// An activation is decided by process id alone, never a bundle id or
/// window title. (Bundle identity is a separate producer's business:
/// `emitContextChanges` uses it to notice the frontmost application
/// changing between polls. This function covers the activation path only.)
/// A window title comes from an accessibility read that can race the window
/// becoming readable and return `nil` exactly at activation — a nil or
/// coincidentally equal title must never be able to invent or hide a
/// switch. A `nil` `lastRecordedProcessId` (nothing recorded yet) always
/// counts as a switch, since a positive `Int32` can never equal `nil`.
func shouldRecordAppSwitch(
    activatedProcessId: Int32,
    lastRecordedProcessId: Int32?,
    excluded: Set<Int32>
) -> Bool {
    guard activatedProcessId > 0 else {
        return false
    }
    guard shouldRecordInput(targetProcessId: activatedProcessId, excluded: excluded) else {
        return false
    }
    return activatedProcessId != lastRecordedProcessId
}

/// The process id `MacInputMonitor` should track as "last recorded" after
/// seeing an event whose target process id is `targetProcessId`. A target
/// process id of zero or less means it could not be determined (for
/// example a key event with no frontmost application reported), which
/// carries no signal, so `current` is kept rather than being overwritten
/// with a meaningless value — that overwrite is what let a later,
/// perfectly ordinary activation of the application the user was already
/// in be misreported as a switch.
func nextRecordedProcessId(current: Int32?, targetProcessId: Int32) -> Int32? {
    targetProcessId > 0 ? targetProcessId : current
}
