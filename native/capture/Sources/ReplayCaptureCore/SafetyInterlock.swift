import Foundation

/// A thread-safe latch shared by the event tap and action adapter. The event
/// tap can trip it even while `SidecarService` is awaiting a long-running drag
/// or text action on its actor executor.
public final class SafetyInterlock: @unchecked Sendable {
    private let lock = NSLock()
    private var tripped = false

    public init() {}

    public func trip() {
        lock.lock()
        tripped = true
        lock.unlock()
    }

    public func reset() {
        lock.lock()
        tripped = false
        lock.unlock()
    }

    public var isTripped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return tripped
    }

    public func check() throws {
        if isTripped {
            throw SidecarOperationError.safetyInterlockEngaged
        }
    }
}
