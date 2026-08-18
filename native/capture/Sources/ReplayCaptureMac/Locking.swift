import Foundation

let replaySyntheticEventMarker: Int64 = 0x52504C59 // "RPLY"

extension NSLocking {
    @discardableResult
    func replayWithLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
